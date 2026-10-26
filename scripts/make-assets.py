"""把发来的白底 logo 做成可用的素材。

三件事
  1. 白底转透明（线稿去背，用 unmultiply 公式，边缘不发灰）
  2. 裁掉多余留白，导出 logo.png 与 icon-180.png
  3. 合成 banner.png（深色底 + 蓝光晕 + 标题 + 副标题），README 顶部用它

跑法：python scripts/make-assets.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
SRC = ASSETS / "logo.jpg"

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_CN = "C:/Windows/Fonts/msyh.ttc"


def white_to_alpha(img: Image.Image) -> Image.Image:
    """线稿去白底。

    JPEG 的「白」不是纯白（常见 #fbfbfb / #f7f7f7），直接按 a = 255 - min(r,g,b) 算，
    那点灰会变成 alpha≈4 的半透明，叠到深色 banner 上就是一圈肉眼可见的灰框。
    所以先减掉一个阈值再把剩下的 alpha 拉伸回来。
    """
    FLOOR = 14
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            a = 255 - min(r, g, b)
            if a <= FLOOR:
                px[x, y] = (0, 0, 0, 0)
                continue
            a = int(min(255, (a - FLOOR) * 255 / (255 - FLOOR)))
            nr = int(min(255, max(0, (r - (255 - a)) * 255 / max(a, 1))))
            ng = int(min(255, max(0, (g - (255 - a)) * 255 / max(a, 1))))
            nb = int(min(255, max(0, (b - (255 - a)) * 255 / max(a, 1))))
            px[x, y] = (nr, ng, nb, a)
    return img


def trim(img: Image.Image) -> Image.Image:
    box = img.getbbox()
    return img.crop(box) if box else img


def radial_glow(size, color, radius_ratio=0.75, peak=110):
    """一张很便宜的径向光晕，用来给深色 banner 一点层次。"""
    w, h = size
    small = Image.new("L", (w // 4, h // 4), 0)
    d = ImageDraw.Draw(small)
    cx, cy = small.size[0] // 2, small.size[1] // 2
    r = int(min(small.size) * radius_ratio)
    for i in range(r, 0, -1):
        t = i / r
        v = int(peak * (1 - t) ** 2)
        d.ellipse([cx - i, cy - i, cx + i, cy + i], fill=v)
    small = small.filter(ImageFilter.GaussianBlur(12)).resize((w, h), Image.LANCZOS)
    layer = Image.new("RGBA", (w, h), color + (0,))
    layer.putalpha(small)
    return layer


def main():
    raw = Image.open(SRC)
    logo = trim(white_to_alpha(raw))

    # 1) 正片叠底用的 logo（透明底）
    target_h = 512
    logo_hd = logo.resize((int(logo.width * target_h / logo.height), target_h), Image.LANCZOS)
    logo_hd.save(ASSETS / "logo.png")

    # 2) 市场卡片 180
    icon = logo.copy()
    icon.thumbnail((150, 150), Image.LANCZOS)
    canvas = Image.new("RGBA", (180, 180), (0, 0, 0, 0))
    canvas.paste(icon, ((180 - icon.width) // 2, (180 - icon.height) // 2), icon)
    canvas.save(ASSETS / "icon-180.png")

    # 3) banner
    W, H = 1280, 380
    bg = Image.new("RGBA", (W, H), (10, 13, 21, 255))
    # 光晕放在偏右，别压在 logo 后面（压上去会显得 logo 那块发灰）
    glow = radial_glow((W, H), (56, 108, 220), 0.55, 130).resize((W, H))
    bg.alpha_composite(glow, (140, -40))
    # 网格：直接写 RGB 值。RGBA 图里用 alpha 画网格会被 convert("RGB") 丢掉，变成纯白线。
    grid = ImageDraw.Draw(bg)
    for x in range(0, W, 40):
        grid.line([(x, 0), (x, H)], fill=(17, 21, 29, 255))
    for y in range(0, H, 40):
        grid.line([(0, y), (W, y)], fill=(17, 21, 29, 255))

    mark = logo.resize((int(logo.width * 232 / logo.height), 232), Image.LANCZOS)
    bg.alpha_composite(mark, (88, (H - mark.height) // 2))

    draw = ImageDraw.Draw(bg)
    title_font = ImageFont.truetype(FONT_BOLD, 66)
    sub_font = ImageFont.truetype(FONT_CN, 25)
    tag_font = ImageFont.truetype(FONT_CN, 19)

    x = 88 + mark.width + 54
    draw.text((x, 92), "DSH Chatlock", font=title_font, fill=(246, 248, 252, 255))
    draw.line([(x + 4, 186), (x + 250, 186)], fill=(76, 141, 255, 255), width=3)
    draw.text((x + 4, 206), "给 DeepSeek Harness 的会话上锁，把目录变成保险箱", font=sub_font, fill=(176, 184, 198, 255))
    draw.text((x + 4, 250), "scrypt 口令 · AES-256-GCM · 锁定后磁盘上只有密文", font=tag_font, fill=(120, 156, 220, 255))

    bg.convert("RGB").save(ASSETS / "banner.png", optimize=True)
    print("logo.png", logo_hd.size)
    print("icon-180.png", canvas.size)
    print("banner.png", (W, H))


if __name__ == "__main__":
    main()
