import argparse
import hashlib
import json
import os
import sys

os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "4")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

try:
    import onnxruntime as _ort
    _ort.set_default_logger_severity(4)
except Exception:
    pass

ANALYZER_VERSION = "v2_wd14_swinv2"

EXPOSED_NUDENET_LABELS = {
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "BUTTOCKS_EXPOSED",
    "ANUS_EXPOSED",
}

HARD_EXPLICIT_TAGS = {
    "sex", "hetero", "yaoi", "yuri", "penis", "pussy", "vaginal", "anal",
    "oral", "fellatio", "cum", "ejaculation", "testicles", "censored",
    "mosaic_censoring", "bar_censor", "light_censor", "uncensored",
    "handjob", "paizuri", "missionary", "straddling", "doggystyle",
    "cowgirl_position", "fingering", "cunnilingus", "rimjob", "masturbation",
    "nipples", "areolae", "pubic_hair", "nude", "completely_nude",
    "bottomless", "topless", "sex_act", "after_sex", "rape", "molestation",
    "groping", "grope", "ass", "butt", "footjob", "thigh_sex", "titfuck",
    "pegging", "orgasm", "facial", "bukkake", "creampie", "x-ray",
    "internal_cumshot", "spread_legs", "spreading_pussy", "erection",
}

SUGGESTIVE_TAGS = {
    "breasts", "large_breasts", "huge_breasts", "cleavage", "panties",
    "underwear", "bra", "lingerie", "bikini", "swimsuit", "bed", "on_bed",
    "french_kiss", "saliva", "ahegao", "undressing", "grabbing_from_behind",
    "cameltoe", "upskirt", "no_panties", "no_bra", "sideboob", "underboob",
    "covered_nipples", "naked_towel", "naked_shirt", "naked_sheet",
}

STRICTNESS_CFG = {
    "lenient": {
        "censor_conf": 0.34,
        "nude_conf": 0.36,
        "wd_explicit": 0.42,
        "wd_unsafe_sum": 0.56,
        "wd_general_min": 0.14,
        "hard_tag": 0.40,
        "soft_tag": 0.65,
        "db_explicit": 0.45,
        "nsfw_explicit": 0.55,
    },
    "balanced": {
        "censor_conf": 0.22,
        "nude_conf": 0.24,
        "wd_explicit": 0.22,
        "wd_unsafe_sum": 0.34,
        "wd_general_min": 0.22,
        "hard_tag": 0.24,
        "soft_tag": 0.50,
        "db_explicit": 0.30,
        "nsfw_explicit": 0.38,
    },
    "strict": {
        "censor_conf": 0.16,
        "nude_conf": 0.18,
        "wd_explicit": 0.12,
        "wd_unsafe_sum": 0.20,
        "wd_general_min": 0.40,
        "hard_tag": 0.16,
        "soft_tag": 0.35,
        "db_explicit": 0.20,
        "nsfw_explicit": 0.26,
    },
}


def clamp01(val):
    return max(0.0, min(1.0, float(val)))


def emit_progress(message, percent):
    print(json.dumps({"type": "progress", "message": message, "percent": int(percent)}, ensure_ascii=False), flush=True)


def check_env():
    info = {
        "hasImgutils": False,
        "hasOnnxGpu": False,
        "hasOpencv": False,
        "providers": [],
        "error": None,
    }
    try:
        import onnxruntime as ort

        ort.set_default_logger_severity(4)
        providers = ort.get_available_providers()
        info["providers"] = providers
        info["hasOnnxGpu"] = "CUDAExecutionProvider" in providers or "DmlExecutionProvider" in providers
    except Exception as exc:
        info["error"] = str(exc)

    try:
        import cv2  # noqa: F401

        info["hasOpencv"] = True
    except Exception:
        pass

    try:
        import imgutils.detect  # noqa: F401
        import imgutils.tagging  # noqa: F401
        import imgutils.validate  # noqa: F401

        info["hasImgutils"] = True
    except Exception as exc:
        info["error"] = str(exc)

    return info


def warmup_models():
    from PIL import Image
    import onnxruntime as ort
    from imgutils.detect import detect_censors, detect_faces, detect_with_nudenet
    from imgutils.tagging import get_wd14_tags
    from imgutils.validate import anime_dbrating_score, nsfw_pred_score

    ort.set_default_logger_severity(4)
    dummy = Image.new("RGB", (320, 320), (240, 240, 240))
    get_wd14_tags(dummy, model_name="SwinV2_v3", general_threshold=0.20)
    anime_dbrating_score(dummy)
    nsfw_pred_score(dummy)
    detect_faces(dummy)
    detect_censors(dummy)
    detect_with_nudenet(dummy)


def trim_whitespace_borders(pil_img):
    """
    Remove outer pure-white / pure-black webtoon padding so classifiers
    see 100% of the actual panel artwork instead of blank margin dilution.
    Returns (cropped_pil, (ax1, ay1, ax2, ay2)) in original pixel coords.
    """
    import numpy as np

    w, h = pil_img.size
    arr = np.asarray(pil_img.convert("RGB"))
    # Pixels that are neither near-white (>242) nor near-black (<10)
    mask = (arr.min(axis=2) < 242) & (arr.max(axis=2) > 10)
    ys, xs = np.where(mask)
    if len(ys) < 64:
        return pil_img, (0, 0, w, h)

    ax1 = max(0, int(xs.min()) - 2)
    ay1 = max(0, int(ys.min()) - 2)
    ax2 = min(w, int(xs.max()) + 3)
    ay2 = min(h, int(ys.max()) + 3)

    if (ax2 - ax1) < 48 or (ay2 - ay1) < 48:
        return pil_img, (0, 0, w, h)

    # Only trim if padding was actually meaningful (>4%)
    if (ax2 - ax1) * (ay2 - ay1) >= 0.96 * w * h:
        return pil_img, (0, 0, w, h)

    return pil_img.crop((ax1, ay1, ax2, ay2)), (ax1, ay1, ax2, ay2)


def norm_box_in_orig(xyxy_art, art_box, orig_w, orig_h):
    ax1, ay1, _ax2, _ay2 = art_box
    x1, y1, x2, y2 = xyxy_art
    ox1 = clamp01((ax1 + x1) / max(1, orig_w))
    oy1 = clamp01((ay1 + y1) / max(1, orig_h))
    ox2 = clamp01((ax1 + x2) / max(1, orig_w))
    oy2 = clamp01((ay1 + y2) / max(1, orig_h))
    return {
        "x": round(ox1, 4),
        "y": round(oy1, 4),
        "w": round(max(0.01, ox2 - ox1), 4),
        "h": round(max(0.01, oy2 - oy1), 4),
    }


def boxes_intersect(a, b, margin=0.0):
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1, bx2, by2 = b["x"] - margin, b["y"] - margin, b["x"] + b["w"] + margin, b["y"] + b["h"] + margin
    return not (ax2 <= bx1 or ax1 >= bx2 or ay2 <= by1 or ay1 >= by2)


def score_pil_image(pil_img, cfg, art_box=None, orig_w=None, orig_h=None):
    from imgutils.detect import detect_censors, detect_with_nudenet
    from imgutils.tagging import get_wd14_tags
    from imgutils.validate import anime_dbrating_score, nsfw_pred_score

    w, h = pil_img.size
    if art_box is None:
        art_box = (0, 0, w, h)
    if orig_w is None:
        orig_w = w
    if orig_h is None:
        orig_h = h

    # 1. WD14 SwinV2_v3 (catches uncensored AND white-light/mosaic/bar censored manhwa scenes + poses)
    wd_rating, wd_tags, _ = get_wd14_tags(pil_img, model_name="SwinV2_v3", general_threshold=0.18)
    wd_explicit = float(wd_rating.get("explicit", 0.0))
    wd_questionable = float(wd_rating.get("questionable", 0.0))
    wd_sensitive = float(wd_rating.get("sensitive", 0.0))
    wd_general = float(wd_rating.get("general", 1.0))
    wd_unsafe_sum = wd_explicit + wd_questionable

    matched_hard = {k: round(float(v), 3) for k, v in wd_tags.items() if k in HARD_EXPLICIT_TAGS}
    matched_soft = {k: round(float(v), 3) for k, v in wd_tags.items() if k in SUGGESTIVE_TAGS}
    hard_tag_max = max(matched_hard.values(), default=0.0)
    soft_tag_max = max(matched_soft.values(), default=0.0)

    # 2. Supplementary classifiers
    db_rating = anime_dbrating_score(pil_img)
    db_explicit = float(db_rating.get("explicit", 0.0))
    nsfw = nsfw_pred_score(pil_img)
    explicit_nsfw = float(nsfw.get("hentai", 0.0)) + float(nsfw.get("porn", 0.0))

    # 3. Localized anatomy/censor boxes
    censors_raw = detect_censors(pil_img, level="s", conf_threshold=cfg["censor_conf"])
    nude_raw = detect_with_nudenet(pil_img, score_threshold=cfg["nude_conf"])

    nsfw_boxes = []
    for xyxy, label, score in censors_raw:
        nsfw_boxes.append({"rect": norm_box_in_orig(xyxy, art_box, orig_w, orig_h), "label": str(label), "score": round(float(score), 3)})
    for xyxy, label, score in nude_raw:
        if str(label) in EXPOSED_NUDENET_LABELS:
            nsfw_boxes.append({"rect": norm_box_in_orig(xyxy, art_box, orig_w, orig_h), "label": str(label), "score": round(float(score), 3)})

    overall_nsfw = max(
        wd_explicit,
        wd_unsafe_sum * 0.92,
        hard_tag_max,
        db_explicit,
        explicit_nsfw,
        0.90 if nsfw_boxes else 0.0,
        (1.0 - wd_general) * 0.65 if wd_general < cfg["wd_general_min"] else 0.0,
    )

    reasons = []
    if nsfw_boxes:
        reasons.append("ил бүс илэрсэн")
    if wd_explicit >= cfg["wd_explicit"]:
        reasons.append(f"explicit {int(wd_explicit*100)}%")
    elif wd_unsafe_sum >= cfg["wd_unsafe_sum"]:
        reasons.append(f"explicit+quest {int(wd_unsafe_sum*100)}%")
    if hard_tag_max >= cfg["hard_tag"]:
        top_tags = ", ".join(k for k, _ in sorted(matched_hard.items(), key=lambda x: -x[1])[:3])
        reasons.append(f"таг: {top_tags}")
    if soft_tag_max >= cfg["soft_tag"] and wd_general < 0.45:
        top_soft = ", ".join(k for k, _ in sorted(matched_soft.items(), key=lambda x: -x[1])[:2])
        reasons.append(f"эмзэг сцен: {top_soft}")
    if wd_general < cfg["wd_general_min"] and (wd_sensitive + wd_unsafe_sum) >= 0.65:
        reasons.append(f"general бага ({int(wd_general*100)}%)")
    if db_explicit >= cfg["db_explicit"]:
        reasons.append(f"dbrating {int(db_explicit*100)}%")
    if explicit_nsfw >= cfg["nsfw_explicit"]:
        reasons.append(f"nsfwjs {int(explicit_nsfw*100)}%")

    is_safe = len(reasons) == 0

    return {
        "safe": is_safe,
        "nsfwScore": round(clamp01(overall_nsfw), 3),
        "explicitScore": round(clamp01(max(wd_explicit, db_explicit, explicit_nsfw)), 3),
        "suggestiveScore": round(clamp01(max(wd_questionable, wd_sensitive)), 3),
        "nsfwBoxes": nsfw_boxes,
        "matchedHardTags": matched_hard,
        "matchedSoftTags": matched_soft,
        "wdGeneral": round(wd_general, 3),
        "reasonText": "; ".join(reasons),
    }


def apply_blur_preview(pil_img, censor_boxes, mode="blur"):
    from PIL import ImageDraw, ImageFilter

    out = pil_img.copy()
    w, h = out.size
    for box in censor_boxes:
        px = max(0, min(w - 2, int(box["x"] * w)))
        py = max(0, min(h - 2, int(box["y"] * h)))
        pw = max(2, min(w - px, int(box["w"] * w)))
        ph = max(2, min(h - py, int(box["h"] * h)))
        if mode == "bar":
            draw = ImageDraw.Draw(out)
            draw.rectangle([px, py, px + pw, py + ph], fill=(10, 10, 12))
        else:
            region = out.crop((px, py, px + pw, py + ph))
            region = region.filter(ImageFilter.GaussianBlur(radius=max(12, min(40, int(min(pw, ph) * 0.25)))))
            out.paste(region, (px, py))
    return out


def compute_safe_face_crop(faces, nsfw_boxes, art_box, orig_w, orig_h, tight=False):
    if not faces:
        return None

    ax1, ay1, ax2, ay2 = art_box
    art_nx1 = ax1 / max(1, orig_w)
    art_ny1 = ay1 / max(1, orig_h)
    art_nx2 = ax2 / max(1, orig_w)
    art_ny2 = ay2 / max(1, orig_h)

    ranked = sorted(faces, key=lambda f: f["w"] * f["h"], reverse=True)
    primary = ranked[0]

    # Reject tiny distant faces inside full-body bed/sex shots unless face is reasonably clear
    if primary["w"] * orig_w < 44 or primary["h"] * orig_h < 44:
        return None

    cx = primary["x"] + primary["w"] / 2.0
    cy = primary["y"] + primary["h"] / 2.0
    mult_w = 1.9 if tight else 2.6
    mult_h = 1.8 if tight else 2.5

    cw = max(0.24, min(art_nx2 - art_nx1, primary["w"] * mult_w))
    ch = max(0.18, min((art_ny2 - art_ny1) * (0.45 if tight else 0.65), primary["h"] * mult_h))

    x1 = max(art_nx1, min(art_nx2 - cw, cx - cw / 2.0))
    y1 = max(art_ny1, min(art_ny2 - ch, cy - ch * 0.42))
    x2 = min(art_nx2, x1 + cw)
    y2 = min(art_ny2, y1 + ch)
    cand = {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}

    face_bottom = primary["y"] + primary["h"]
    for nb in nsfw_boxes:
        r = nb["rect"]
        if boxes_intersect(cand, r, margin=0.04):
            if r["y"] >= face_bottom - 0.01:
                new_y2 = clamp01(r["y"] - 0.05)
                if new_y2 - cand["y"] >= 0.14:
                    cand["h"] = new_y2 - cand["y"]
                else:
                    return None
            else:
                return None

    px_w = cand["w"] * orig_w
    px_h = cand["h"] * orig_h
    if px_w < 130 or px_h < 110:
        return None

    return {k: round(v, 4) for k, v in cand.items()}


def merge_censor_boxes(nsfw_boxes, default_mode="blur"):
    boxes = []
    for idx, nb in enumerate(nsfw_boxes[:8]):
        r = nb["rect"]
        pad_x = max(0.03, r["w"] * 0.25)
        pad_y = max(0.03, r["h"] * 0.25)
        x = clamp01(r["x"] - pad_x)
        y = clamp01(r["y"] - pad_y)
        x2 = clamp01(r["x"] + r["w"] + pad_x)
        y2 = clamp01(r["y"] + r["h"] + pad_y)
        boxes.append({
            "id": f"auto_{idx}",
            "x": round(x, 4),
            "y": round(y, 4),
            "w": round(max(0.04, x2 - x), 4),
            "h": round(max(0.04, y2 - y), 4),
            "mode": default_mode,
            "strength": 24,
        })
    return boxes


def analyze_single_panel(panel, cfg, default_mode):
    from PIL import Image
    from imgutils.detect import detect_faces

    path = panel["path"]
    if not os.path.exists(path):
        return {"id": panel["id"], "safetyStatus": "excluded", "safetyReason": "Файл олдсонгүй"}

    with Image.open(path) as raw:
        pil_img = raw.convert("RGB")
        orig_w, orig_h = pil_img.size

        # Trim pure white/black margins before inference so artwork fills the model input!
        art_img, art_box = trim_whitespace_borders(pil_img)
        aw, ah = art_img.size

        if max(aw, ah) > 1280:
            scale = 1280.0 / max(aw, ah)
            infer_img = art_img.resize((max(64, int(aw * scale)), max(64, int(ah * scale))))
            sx = aw / infer_img.size[0]
            sy = ah / infer_img.size[1]
        else:
            infer_img = art_img
            sx = 1.0
            sy = 1.0

        base = score_pil_image(infer_img, cfg, art_box=art_box, orig_w=orig_w, orig_h=orig_h)
        faces_raw = detect_faces(infer_img, level="s", conf_threshold=0.25)
        face_boxes = [
            norm_box_in_orig((xyxy[0] * sx, xyxy[1] * sy, xyxy[2] * sx, xyxy[3] * sy), art_box, orig_w, orig_h)
            for xyxy, _lbl, _sc in faces_raw
        ]

        # Also check top/bottom halves for very tall panels so small explicit zones aren't squished
        if base["safe"] and ah > aw * 1.65:
            mid_y = ah // 2
            overlap = int(ah * 0.12)
            for tile, ty_off in [(art_img.crop((0, 0, aw, min(ah, mid_y + overlap))), 0), (art_img.crop((0, max(0, mid_y - overlap), aw, ah)), max(0, mid_y - overlap))]:
                tile_box = (art_box[0], art_box[1] + ty_off, art_box[2], art_box[1] + ty_off + tile.size[1])
                t_score = score_pil_image(tile, cfg, art_box=tile_box, orig_w=orig_w, orig_h=orig_h)
                if not t_score["safe"]:
                    base = t_score
                    break

        if base["safe"]:
            return {
                "id": panel["id"],
                "safetyStatus": "safe",
                "nsfwScore": base["nsfwScore"],
                "explicitScore": base["explicitScore"],
                "suggestiveScore": base["suggestiveScore"],
                "faceBoxes": face_boxes,
                "nsfwBoxes": base["nsfwBoxes"],
                "cropRect": None,
                "censorBoxes": [],
                "recheckSafe": True,
                "needsReview": False,
                "safetyReason": "Аюулгүй (SFW)",
            }

        # Strategy B1: Try safe face/upper crop (normal first, then tight face-only if sex tags present)
        has_sex_act = any(
            k in base["matchedHardTags"] and base["matchedHardTags"][k] >= 0.28
            for k in ("sex", "hetero", "yaoi", "yuri", "missionary", "straddling", "anal", "censored", "penis", "pussy", "handjob")
        )
        for tight_mode in ([True] if has_sex_act else [False, True]):
            crop_rect = compute_safe_face_crop(face_boxes, base["nsfwBoxes"], art_box, orig_w, orig_h, tight=tight_mode)
            if not crop_rect:
                continue
            cx1 = int(crop_rect["x"] * orig_w)
            cy1 = int(crop_rect["y"] * orig_h)
            cx2 = int((crop_rect["x"] + crop_rect["w"]) * orig_w)
            cy2 = int((crop_rect["y"] + crop_rect["h"]) * orig_h)
            if cx2 - cx1 >= 64 and cy2 - cy1 >= 64:
                cropped_pil = pil_img.crop((cx1, cy1, cx2, cy2))
                trimmed_crop, _ = trim_whitespace_borders(cropped_pil)
                recheck = score_pil_image(trimmed_crop, cfg)
                if recheck["safe"]:
                    return {
                        "id": panel["id"],
                        "safetyStatus": "cropped",
                        "nsfwScore": base["nsfwScore"],
                        "explicitScore": base["explicitScore"],
                        "suggestiveScore": base["suggestiveScore"],
                        "faceBoxes": face_boxes,
                        "nsfwBoxes": base["nsfwBoxes"],
                        "cropRect": crop_rect,
                        "censorBoxes": [],
                        "recheckSafe": True,
                        "needsReview": True,
                        "safetyReason": f"Царайны аюулгүй хэсгийг тайрсан ({base['reasonText']})",
                    }

        # Strategy B2: Try localized censor boxes (only if exact anatomical boxes were localized and <=45% area)
        if base["nsfwBoxes"]:
            cboxes = merge_censor_boxes(base["nsfwBoxes"], default_mode)
            total_cov = sum(b["w"] * b["h"] for b in cboxes)
            if total_cov <= 0.45:
                blurred_pil = apply_blur_preview(pil_img, cboxes, default_mode)
                trimmed_blur, _ = trim_whitespace_borders(blurred_pil)
                recheck = score_pil_image(trimmed_blur, cfg)
                if recheck["safe"]:
                    return {
                        "id": panel["id"],
                        "safetyStatus": "blurred",
                        "nsfwScore": base["nsfwScore"],
                        "explicitScore": base["explicitScore"],
                        "suggestiveScore": base["suggestiveScore"],
                        "faceBoxes": face_boxes,
                        "nsfwBoxes": base["nsfwBoxes"],
                        "cropRect": None,
                        "censorBoxes": cboxes,
                        "recheckSafe": True,
                        "needsReview": True,
                        "safetyReason": f"Эмзэг хэсэгт {default_mode} хаалт тавьсан ({base['reasonText']})",
                    }

        # Strategy B3: Explicit / white-light-censored +18 panel -> Exclude
        return {
            "id": panel["id"],
            "safetyStatus": "excluded",
            "nsfwScore": base["nsfwScore"],
            "explicitScore": base["explicitScore"],
            "suggestiveScore": base["suggestiveScore"],
            "faceBoxes": face_boxes,
            "nsfwBoxes": base["nsfwBoxes"],
            "cropRect": None,
            "censorBoxes": merge_censor_boxes(base["nsfwBoxes"], default_mode) if base["nsfwBoxes"] else [],
            "recheckSafe": False,
            "needsReview": False,
            "safetyReason": f"+18 хассан ({base['reasonText']})",
        }


def run_analyze(input_path, output_path):
    import onnxruntime as ort

    ort.set_default_logger_severity(4)
    with open(input_path, "r", encoding="utf-8") as f:
        req = json.load(f)

    panels = req.get("panels", [])
    strictness = req.get("strictness", "balanced")
    default_mode = req.get("defaultCensorMode", "blur")
    cache_dir = req.get("cacheDir", "")
    cfg = STRICTNESS_CFG.get(strictness, STRICTNESS_CFG["balanced"])

    cache_file = os.path.join(cache_dir, "safety_analysis_cache.json") if cache_dir else ""
    disk_cache = {}
    if cache_file and os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                disk_cache = json.load(f)
        except Exception:
            disk_cache = {}

    results = []
    total = max(1, len(panels))
    for idx, panel in enumerate(panels):
        p = panel["path"]
        try:
            st = os.stat(p)
            sig = hashlib.sha1(
                f"{ANALYZER_VERSION}|{p}|{st.st_size}|{int(st.st_mtime)}|{strictness}|{default_mode}".encode("utf-8")
            ).hexdigest()[:16]
        except Exception:
            sig = None

        emit_progress(f"Локал +18 шүүлт хийж байна ({idx + 1}/{len(panels)})...", int(((idx) / total) * 78))

        if sig and sig in disk_cache:
            cached = dict(disk_cache[sig])
            cached["id"] = panel["id"]
            results.append(cached)
            continue

        res = analyze_single_panel(panel, cfg, default_mode)
        if sig:
            disk_cache[sig] = res
        results.append(res)

    if cache_file:
        try:
            os.makedirs(os.path.dirname(cache_file), exist_ok=True)
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(disk_cache, f, ensure_ascii=False)
        except Exception:
            pass

    emit_progress("Локал шүүлт дууслаа!", 80)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "results": results}, f, ensure_ascii=False)


def run_recheck(image_path, strictness):
    from PIL import Image
    import onnxruntime as ort

    ort.set_default_logger_severity(4)
    cfg = STRICTNESS_CFG.get(strictness, STRICTNESS_CFG["balanced"])
    with Image.open(image_path) as raw:
        art_img, _ = trim_whitespace_borders(raw.convert("RGB"))
        res = score_pil_image(art_img, cfg)
    print(json.dumps(res, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["env", "warmup", "analyze", "recheck"])
    parser.add_argument("--input", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--image", default="")
    parser.add_argument("--strictness", default="balanced")
    args = parser.parse_args()

    if args.mode == "env":
        print(json.dumps(check_env(), ensure_ascii=False), flush=True)
    elif args.mode == "warmup":
        warmup_models()
        print(json.dumps({"ok": True}), flush=True)
    elif args.mode == "analyze":
        run_analyze(args.input, args.output)
    elif args.mode == "recheck":
        run_recheck(args.image, args.strictness)


if __name__ == "__main__":
    main()
