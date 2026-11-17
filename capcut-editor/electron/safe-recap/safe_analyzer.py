import argparse
import hashlib
import json
import os
import sys

os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "4")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

EXPOSED_NUDENET_LABELS = {
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "BUTTOCKS_EXPOSED",
    "ANUS_EXPOSED",
}

STRICTNESS_CFG = {
    "lenient": {
        "censor_conf": 0.38,
        "nude_conf": 0.40,
        "r18_block": 0.65,
        "r15_warn": 0.75,
        "nsfw_block": 0.70,
        "sexy_warn": 0.85,
    },
    "balanced": {
        "censor_conf": 0.28,
        "nude_conf": 0.30,
        "r18_block": 0.45,
        "r15_warn": 0.58,
        "nsfw_block": 0.55,
        "sexy_warn": 0.72,
    },
    "strict": {
        "censor_conf": 0.22,
        "nude_conf": 0.24,
        "r18_block": 0.30,
        "r15_warn": 0.42,
        "nsfw_block": 0.40,
        "sexy_warn": 0.58,
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
        import imgutils.validate  # noqa: F401

        info["hasImgutils"] = True
    except Exception as exc:
        info["error"] = str(exc)

    return info


def warmup_models():
    from PIL import Image
    import onnxruntime as ort
    from imgutils.detect import detect_censors, detect_faces, detect_halfbody, detect_with_nudenet
    from imgutils.validate import anime_rating_score, nsfw_pred_score

    ort.set_default_logger_severity(4)
    dummy = Image.new("RGB", (320, 320), (240, 240, 240))
    nsfw_pred_score(dummy)
    anime_rating_score(dummy)
    detect_faces(dummy)
    detect_halfbody(dummy)
    detect_censors(dummy)
    detect_with_nudenet(dummy)


def norm_box_from_xyxy(xyxy, w, h):
    x1, y1, x2, y2 = xyxy
    nx1 = clamp01(x1 / max(1, w))
    ny1 = clamp01(y1 / max(1, h))
    nx2 = clamp01(x2 / max(1, w))
    ny2 = clamp01(y2 / max(1, h))
    return {
        "x": round(nx1, 4),
        "y": round(ny1, 4),
        "w": round(max(0.01, nx2 - nx1), 4),
        "h": round(max(0.01, ny2 - ny1), 4),
    }


def boxes_intersect(a, b, margin=0.0):
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1, bx2, by2 = b["x"] - margin, b["y"] - margin, b["x"] + b["w"] + margin, b["y"] + b["h"] + margin
    return not (ax2 <= bx1 or ax1 >= bx2 or ay2 <= by1 or ay1 >= by2)


def score_pil_image(pil_img, cfg):
    from imgutils.detect import detect_censors, detect_with_nudenet
    from imgutils.validate import anime_rating_score, nsfw_pred_score

    w, h = pil_img.size
    rating = anime_rating_score(pil_img)
    nsfw = nsfw_pred_score(pil_img)

    r18 = float(rating.get("r18", 0.0))
    r15 = float(rating.get("r15", 0.0))
    explicit_nsfw = float(nsfw.get("hentai", 0.0)) + float(nsfw.get("porn", 0.0))
    sexy = float(nsfw.get("sexy", 0.0))

    censors_raw = detect_censors(pil_img, level="s", conf_threshold=cfg["censor_conf"])
    nude_raw = detect_with_nudenet(pil_img, score_threshold=cfg["nude_conf"])

    nsfw_boxes = []
    for xyxy, label, score in censors_raw:
        nsfw_boxes.append({"rect": norm_box_from_xyxy(xyxy, w, h), "label": str(label), "score": round(float(score), 3)})

    for xyxy, label, score in nude_raw:
        if str(label) in EXPOSED_NUDENET_LABELS:
            nsfw_boxes.append({"rect": norm_box_from_xyxy(xyxy, w, h), "label": str(label), "score": round(float(score), 3)})

    overall_nsfw = max(r18, explicit_nsfw, 0.85 if nsfw_boxes else 0.0, r15 * 0.7, sexy * 0.65)
    is_safe = (
        len(nsfw_boxes) == 0
        and r18 < cfg["r18_block"]
        and explicit_nsfw < cfg["nsfw_block"]
        and r15 < cfg["r15_warn"]
        and sexy < cfg["sexy_warn"]
    )
    return {
        "safe": is_safe,
        "nsfwScore": round(clamp01(overall_nsfw), 3),
        "explicitScore": round(clamp01(max(r18, explicit_nsfw)), 3),
        "suggestiveScore": round(clamp01(max(r15, sexy)), 3),
        "nsfwBoxes": nsfw_boxes,
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


def compute_safe_face_crop(faces, nsfw_boxes, img_w, img_h):
    if not faces:
        return None

    # Sort faces by prominence (area * confidence)
    ranked = sorted(faces, key=lambda f: f["w"] * f["h"], reverse=True)
    primary = ranked[0]

    # Build generous framing around primary face
    cx = primary["x"] + primary["w"] / 2.0
    cy = primary["y"] + primary["h"] / 2.0
    cw = max(0.45, min(1.0, primary["w"] * 3.0))
    ch = max(0.32, min(0.75, primary["h"] * 3.2))

    x1 = clamp01(cx - cw / 2.0)
    y1 = clamp01(cy - ch * 0.40)
    x2 = clamp01(x1 + cw)
    y2 = clamp01(y1 + ch)
    if x2 - x1 < cw:
        x1 = clamp01(x2 - cw)
    if y2 - y1 < ch:
        y1 = clamp01(y2 - ch)

    cand = {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}

    # Trim bottom above any NSFW box that lies below the face
    face_bottom = primary["y"] + primary["h"]
    for nb in nsfw_boxes:
        r = nb["rect"]
        if boxes_intersect(cand, r, margin=0.04):
            if r["y"] >= face_bottom - 0.02:
                # Sensitive region is below the face -> crop cleanly above it
                new_y2 = clamp01(r["y"] - 0.05)
                if new_y2 - cand["y"] >= 0.18:
                    cand["h"] = new_y2 - cand["y"]
                else:
                    return None
            else:
                return None

    # If no localized box was found (global score fired), keep upper face region safely
    if not nsfw_boxes and cand["y"] + cand["h"] > 0.62 and face_bottom < 0.56:
        cand["h"] = max(0.24, min(cand["h"], 0.58 - cand["y"]))

    px_w = cand["w"] * img_w
    px_h = cand["h"] * img_h
    if px_w < 160 or px_h < 120 or cand["w"] < 0.20 or cand["h"] < 0.16:
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
        w, h = pil_img.size

        # Downscale huge strips slightly for faster inference while keeping exact normalized coordinates
        if max(w, h) > 1280:
            scale = 1280.0 / max(w, h)
            infer_img = pil_img.resize((max(64, int(w * scale)), max(64, int(h * scale))))
        else:
            infer_img = pil_img

        base = score_pil_image(infer_img, cfg)
        iw, ih = infer_img.size
        faces_raw = detect_faces(infer_img, level="s", conf_threshold=0.25)
        face_boxes = [norm_box_from_xyxy(xyxy, iw, ih) for xyxy, _lbl, _sc in faces_raw]

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

        # Strategy B1: Try safe face/upper crop first
        crop_rect = compute_safe_face_crop(face_boxes, base["nsfwBoxes"], w, h)
        if crop_rect:
            cx1 = int(crop_rect["x"] * w)
            cy1 = int(crop_rect["y"] * h)
            cx2 = int((crop_rect["x"] + crop_rect["w"]) * w)
            cy2 = int((crop_rect["y"] + crop_rect["h"]) * h)
            if cx2 - cx1 >= 64 and cy2 - cy1 >= 64:
                cropped_pil = pil_img.crop((cx1, cy1, cx2, cy2))
                recheck = score_pil_image(cropped_pil, cfg)
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
                        "safetyReason": "Царай/дээд аюулгүй хэсгийг автоматаар тайрсан",
                    }

        # Strategy B2: Try localized censor boxes (blur/mosaic/bar/glow)
        if base["nsfwBoxes"]:
            cboxes = merge_censor_boxes(base["nsfwBoxes"], default_mode)
            total_cov = sum(b["w"] * b["h"] for b in cboxes)
            if total_cov <= 0.55:
                blurred_pil = apply_blur_preview(infer_img, cboxes, default_mode)
                recheck = score_pil_image(blurred_pil, cfg)
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
                        "safetyReason": f"Эмзэг хэсэгт {default_mode} хаалт тавьсан",
                    }

        # Strategy B3: Unsalvageable explicit panel -> Exclude
        return {
            "id": panel["id"],
            "safetyStatus": "excluded",
            "nsfwScore": base["nsfwScore"],
            "explicitScore": base["explicitScore"],
            "suggestiveScore": base["suggestiveScore"],
            "faceBoxes": face_boxes,
            "nsfwBoxes": base["nsfwBoxes"],
            "cropRect": crop_rect,
            "censorBoxes": merge_censor_boxes(base["nsfwBoxes"], default_mode) if base["nsfwBoxes"] else [],
            "recheckSafe": False,
            "needsReview": False,
            "safetyReason": "Бүрэн +18 тул хассан (аюулгүй кадраар орлуулна)",
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
            sig = hashlib.sha1(f"{p}|{st.st_size}|{int(st.st_mtime)}|{strictness}|{default_mode}".encode("utf-8")).hexdigest()[:16]
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
        res = score_pil_image(raw.convert("RGB"), cfg)
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
