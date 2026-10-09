from PIL import Image, ImageDraw, ImageFilter
from collections import deque
OUT='/home/claude/ascandir---nsc-group-automation/assets/'
src=Image.open('ref.png').convert('RGBA')
W,H=src.size

# --- 1) Schachbrett-Hintergrund entfernen (Flood-Fill von den Rändern)
px=src.load()
def bg(c):
    r,g,b,a=c
    return min(r,g,b)>=196 and max(r,g,b)-min(r,g,b)<=14
seen=bytearray(W*H); q=deque()
for x in range(W):
    for y in (0,H-1): q.append((x,y))
for y in range(H):
    for x in (0,W-1): q.append((x,y))
while q:
    x,y=q.popleft()
    i=y*W+x
    if seen[i]: continue
    seen[i]=1
    if not bg(px[x,y]): continue
    px[x,y]=(0,0,0,0)
    for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx,ny=x+dx,y+dy
        if 0<=nx<W and 0<=ny<H and not seen[ny*W+nx]: q.append((nx,ny))
# weiche Kante: halbtransparente Randpixel
alpha=src.getchannel('A').filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
src.putalpha(alpha)

# --- 2) Rahmen: Innenbereich ausschneiden
L,T,R,B=146,160,161,250
frame=src.copy()
# Reste von "Neue Mission"/"Entsenden" rechts übermalen
woodsrc=src.crop((540,462,980,560))
for y in range(545,797,98):
    frame.paste(woodsrc.crop((0,0,1392-1335,min(98,797-y))),(1335,y))
frame.paste(src.crop((1352,478,1369,548)),(1335,478))
frame.paste(src.crop((600,148,974,161)),(146,148))
d=ImageDraw.Draw(frame)
d.rectangle((L,T,W-R-1,H-B-1),fill=(0,0,0,0))
frame.save(OUT+'frame.png',optimize=True)

# --- 3) Holz-Kachel (nahtlos durch Spiegelung)
wood=src.crop((540,462,980,560)).convert('RGB')
tile=Image.new('RGB',(wood.width*2,wood.height))
tile.paste(wood,(0,0)); tile.paste(wood.transpose(Image.FLIP_LEFT_RIGHT),(wood.width,0))
tile2=Image.new('RGB',(tile.width,tile.height*2))
tile2.paste(tile,(0,0)); tile2.paste(tile.transpose(Image.FLIP_TOP_BOTTOM),(0,tile.height))
tile2.save(OUT+'wood.jpg',quality=88)

# --- Pergament-Kachel (nahtlos gespiegelt)
patch=src.crop((450,372,650,430)).convert('RGB')
pt=Image.new('RGB',(patch.width*2,patch.height*2))
pt.paste(patch,(0,0)); pt.paste(patch.transpose(Image.FLIP_LEFT_RIGHT),(patch.width,0))
low=pt.crop((0,0,pt.width,patch.height)).transpose(Image.FLIP_TOP_BOTTOM)
pt.paste(low,(0,patch.height))
pt.save(OUT+'parchment.jpg',quality=90)

def edges(box, seal=None, seal_src=None):
    img=src.crop(box).copy()
    if seal:
        sx0,sx1,sy1=seal
        img.paste(img.crop((seal_src,0,seal_src+(sx1-sx0),sy1)),(sx0,0))
    return img

edges((165,262,681,456),seal=(215,285,32),seal_src=60).save(OUT+'card.png',optimize=True)
pan=edges((147,571,1374,794),seal=(700,760,32),seal_src=200)
pan.paste(pan.crop((300,0,476,32)),(1035,0))   # Knopf "Entsenden" + Trennlinie aus der Oberkante entfernen
pan.paste(pan.crop((300,pan.height-32,476,pan.height)),(1035,pan.height-32))
pan.paste(pan.crop((1195,110,1215,170)),(1195,14))
pan.save(OUT+"panel.png",optimize=True)

# Schild: Text/Icon durch sauberes Pergament ersetzen
sign=src.crop((130,155,520,240)).copy()
clean=src.crop((380,168,450,228))
sign.paste(clean.resize((290,60),Image.BICUBIC),(40,13))
sign.save(OUT+'sign.png',optimize=True)

seal=src.crop((389,243,436,290)).copy()
m=Image.new('L',seal.size,0); ImageDraw.Draw(m).ellipse((1,1,seal.width-2,seal.height-2),fill=255)
seal.putalpha(m.filter(ImageFilter.GaussianBlur(0.7)))
seal.save(OUT+'seal.png',optimize=True)
print('ok')

for n in ['frame','card','panel','sign','seal']:
    Image.open(OUT+n+'.png').save(OUT+n+'.webp','WEBP',quality=88,method=6)
    import os; os.remove(OUT+n+'.png')
