"""
Erzeugt die Design-Grafiken in ../assets aus der Design-Vorlage (ref2.png).
Aufruf: python3 build_assets.py <pfad/zur/vorlage.png>
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else "ref2.png"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets") + "/"
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    os.remove(OUT + f)
src = Image.open(SRC).convert("RGBA")
FL = Image.FLIP_LEFT_RIGHT

def save(img, name, q=90):
    img.save(OUT + name + ".webp", "WEBP", quality=q, method=6)

def masked(box, polys=(), ellipses=(), offset=None):
    """Ausschnitt mit Polygon-/Ellipsen-Maske (Koordinaten im Original)."""
    x0, y0, x1, y1 = box
    img = src.crop(box).copy()
    m = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(m)
    for p in polys:
        d.polygon([(x - x0, y - y0) for x, y in p], fill=255)
    for (cx, cy, r) in ellipses:
        d.ellipse((cx - r - x0, cy - r - y0, cx + r - x0, cy + r - y0), fill=255)
    img.putalpha(m.filter(ImageFilter.GaussianBlur(0.8)))
    return img

# ---- Fensterrahmen (9-Slice): Ecke oben 40x70, Seiten 40, unten 53
TL = src.crop((8, 28, 48, 98)); TOP = src.crop((330, 28, 630, 98))
LEFT = src.crop((8, 300, 48, 700)); BL = src.crop((8, 965, 48, 1018)); BOT = src.crop((300, 965, 600, 1018))
frame = Image.new("RGBA", (380, 70 + 400 + 53), (0, 0, 0, 0))
frame.paste(TL, (0, 0)); frame.paste(TOP, (40, 0)); frame.paste(TL.transpose(FL), (340, 0))
frame.paste(LEFT, (0, 70)); frame.paste(LEFT.transpose(FL), (340, 70))
frame.paste(BL, (0, 470)); frame.paste(BOT, (40, 470)); frame.paste(BL.transpose(FL), (340, 470))
save(frame, "frame")

# ---- Eisenwinkel unten links (rechts = gespiegelt)
bracket = masked((8, 915, 102, 1020), polys=[[(9, 920), (47, 920), (56, 934), (72, 950), (82, 958), (82, 968),
                                               (101, 968), (101, 1012), (95, 1019), (14, 1019), (9, 1012)]])
save(bracket, "bracket")

# ---- Kompass-Medaillon
compass = masked((655, 28, 830, 162), ellipses=[(742, 95, 60)],
                 polys=[[(662, 95), (690, 77), (795, 77), (822, 95), (795, 113), (690, 113)],
                        [(742, 30), (764, 46), (720, 46)], [(742, 160), (762, 144), (722, 144)]])
save(compass, "compass")

# ---- Roter Behang (Kachel von Haken zu Haken)
save(src.crop((210, 95, 515, 168)), "drape")

# ---- Holz (nahtlos gespiegelt)
w = src.crop((430, 540, 1190, 640)).convert("RGB")
t = Image.new("RGB", (w.width * 2, w.height * 2))
t.paste(w, (0, 0)); t.paste(w.transpose(FL), (w.width, 0))
t.paste(t.crop((0, 0, t.width, w.height)).transpose(Image.FLIP_TOP_BOTTOM), (0, w.height))
t.save(OUT + "wood.jpg", quality=88)

# ---- Pergament-Kachel aus sauberem Kartenbereich
p = src.crop((300, 395, 560, 425)).convert("RGB")
pt = Image.new("RGB", (p.width * 2, p.height * 2))
pt.paste(p, (0, 0)); pt.paste(p.transpose(FL), (p.width, 0))
pt.paste(pt.crop((0, 0, pt.width, p.height)).transpose(Image.FLIP_TOP_BOTTOM), (0, p.height))
pt.save(OUT + "parchment.jpg", quality=90)

import numpy as np

GRAIN = None
def grain():
    """Feine Papierstruktur (Hochpass) aus einem sauberen Pergamentstück."""
    global GRAIN
    if GRAIN is None:
        p = np.asarray(src.crop((300, 380, 420, 420)).convert("L"), dtype=np.float32)
        blur = np.asarray(Image.fromarray(p.astype(np.uint8)).filter(ImageFilter.GaussianBlur(4)), dtype=np.float32)
        hp = p - blur
        tile = np.concatenate([hp, hp[:, ::-1]], axis=1)
        GRAIN = np.concatenate([tile, tile[::-1, :]], axis=0)
    return GRAIN

def smooth_center(img, border):
    """Mitte komplett neu aufbauen: aus den Randfarben "hineinwachsen" lassen
    (Diffusion) und Papierstruktur darüberlegen – kein Text, keine Kante."""
    w, h = img.size
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    known = np.zeros((h, w), bool)
    known[:border, :] = known[-border:, :] = True
    known[:, :border] = known[:, -border:] = True
    sc = 4
    small = np.asarray(img.convert("RGB").resize((w // sc, h // sc), Image.BILINEAR), dtype=np.float32)
    ks = np.asarray(Image.fromarray((known * 255).astype(np.uint8)).resize((w // sc, h // sc), Image.NEAREST)) > 0
    fill = small.copy()
    fill[~ks] = small[ks].mean(axis=0)
    for _ in range(400):
        f = fill
        avg = (np.roll(f, 1, 0) + np.roll(f, -1, 0) + np.roll(f, 1, 1) + np.roll(f, -1, 1)) / 4
        fill = np.where(ks[..., None], small, avg)
    big = np.asarray(Image.fromarray(fill.clip(0, 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), dtype=np.float32)
    g = grain()
    gy = np.tile(g, (h // g.shape[0] + 1, w // g.shape[1] + 1))[:h, :w]
    big = big + gy[..., None] * 0.9
    m = np.zeros((h, w), np.float32)
    m[border:h - border, border:w - border] = 1
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4)), dtype=np.float32)[..., None] / 255
    out = rgb * (1 - m) + big * m
    res = Image.fromarray(out.clip(0, 255).astype(np.uint8)).convert("RGBA")
    res.putalpha(img.getchannel("A"))
    return res

# ---- Gruppenkarte; Siegel und Bannerstange aus der Oberkante entfernen
card = src.crop((62, 262, 726, 526)).copy()
card.paste(card.crop((120, 0, 190, 34)), (300, 0))
card.paste(card.crop((170, 12, 290, 36)), (36, 12))
card.paste(card.crop((card.width - 44, 120, card.width, 190)), (card.width - 44, 25))  # Augen-Knopf aus dem rechten Rand
card = smooth_center(card, 24)
save(card, "card")

# ---- Missionszeile
row = src.crop((60, 712, 1426, 862)).copy()
# rechte Kante: Knopf-Reste durch gespiegelte linke Kante ersetzen
row.paste(row.crop((0, 30, 34, row.height - 30)).transpose(FL), (row.width - 34, 30))
row = smooth_center(row, 22)
save(row, "row")

# ---- Tabellenkopf (dunkle Leiste): Mitte durch leeres Stück ersetzen
head = src.crop((60, 655, 1426, 712)).copy()
clean = head.crop((1050, 8, 1300, 49))
head.paste(clean.resize((head.width - 80, 41)), (40, 8))
head.paste(head.crop((0, 0, 40, head.height)).transpose(FL), (head.width - 40, 0))
save(head, "thead")

# ---- Schild (Gruppen/Missionen) ohne Text
sign = src.crop((58, 165, 412, 247)).copy()
sclean = sign.crop((300, 14, 330, 66))
sign.paste(sclean.resize((250, 52)), (40, 14))
save(sign, "sign")

# ---- Wachssiegel
seal = masked((376, 244, 430, 298), ellipses=[(403, 271, 26)])
save(seal, "seal")

# ---- Zettel unten
notes_l = masked((84, 862, 338, 975), polys=[
    [(86, 897), (225, 882), (230, 965), (88, 972)], [(237, 885), (333, 877), (336, 953), (240, 957)],
    [(128, 882), (147, 882), (147, 914), (128, 914)], [(288, 878), (307, 878), (307, 907), (288, 907)]])
save(notes_l, "notes-left")
notes_r = masked((1146, 862, 1406, 972), polys=[
    [(1150, 868), (1257, 872), (1253, 950), (1152, 946)], [(1285, 878), (1402, 883), (1400, 968), (1288, 962)],
    [(1178, 864), (1195, 864), (1195, 887), (1178, 887)], [(1336, 880), (1354, 880), (1354, 920), (1336, 920)]])
save(notes_r, "notes-right")
print("assets:", sorted(os.listdir(OUT)))
