# Erzeugt icons/icon-192.png, icon-512.png und icon-maskable-512.png
# (gleiches Motiv wie icons/icon.svg). Braucht Python 3 + Pillow:  python3 tools/gen-icons.py
from PIL import Image, ImageDraw

def draw(size, maskable=False):
    S = 4; W = size * S
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    grad = Image.new('RGBA', (W, W)); gd = ImageDraw.Draw(grad)
    for y in range(W):  # Verlauf gelb -> gold
        t = y / W
        gd.line([(0, y), (W, y)], fill=(int(255 - 13 * t), int(210 - 41 * t), int(63 - 63 * t), 255))
    mask = Image.new('L', (W, W), 0); md = ImageDraw.Draw(mask)
    if maskable: md.rectangle([0, 0, W, W], fill=255)
    else: md.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 112 / 512), fill=255)
    img.paste(grad, (0, 0), mask)
    k = 0.78 if maskable else 1.0  # maskierbar: Motiv in der sicheren Zone
    def p(x, y): return (W / 2 + (x - 256) * k * W / 512, W / 2 + (y - 256) * k * W / 512)
    def s(v): return v * k * W / 512
    x0, y0 = p(128, 112); x1, y1 = p(382, 412)
    d.rounded_rectangle([x0, y0, x1, y1], radius=s(22), fill=(255, 253, 246, 255))  # Blatt
    corner = Image.new('L', (W, W), 0); ImageDraw.Draw(corner).polygon([p(310, 111), p(383, 111), p(383, 184)], fill=255)
    img.paste(grad, (0, 0), corner)  # Eselsohr ausschneiden
    d.polygon([p(310, 112), p(310, 162), p(332, 184), p(382, 184)], fill=(243, 223, 160, 255))
    for a, b in [((178, 238), (334, 238)), ((178, 290), (334, 290)), ((232, 342), (334, 342))]:
        d.line([p(*a), p(*b)], fill=(201, 194, 176, 255), width=int(s(14)))
        for q in (a, b):
            cx, cy = p(*q); r = s(7); d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(201, 194, 176, 255))
    d.line([p(174, 340), p(192, 358), p(222, 324)], fill=(224, 161, 0, 255), width=int(s(16)), joint='curve')  # Haken
    return img.resize((size, size), Image.LANCZOS)

draw(192).save('icons/icon-192.png')
draw(512).save('icons/icon-512.png')
draw(512, True).save('icons/icon-maskable-512.png')
