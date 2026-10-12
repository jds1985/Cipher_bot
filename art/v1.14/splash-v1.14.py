import math
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops
BLUE=(0x5b,0x8c,0xff); DARK=(0x15,0x17,0x1c)
W,H=2200,1520; cx,cy=W/2,H/2
tr=Image.new("L",(W,H),0); d=ImageDraw.Draw(tr)
s=34; k=math.tan(math.radians(22.5))
font=ImageFont.truetype("/usr/share/fonts/truetype/sand-box/google/Orbitron/Orbitron-VariableFont_wght.ttf",230)
try: font.set_variation_by_name("Bold")
except Exception: pass
tm=Image.new("L",(W,H),0); td=ImageDraw.Draw(tm)
# v1.14: the word is now "Cipher Bot". The tracers keep the exact v1.4 geometry (laid out around the width
# "Cipher" had at 230 px), and "Cipher Bot" is drawn at the size that fills that same width, centered.
bb=td.textbbox((0,0),"Cipher",font=font)
tw,th=bb[2]-bb[0],bb[3]-bb[1]
L,R=(W-tw)/2,(W+tw)/2
WORD="Cipher Bot"
size=230
while True:
    wf=ImageFont.truetype("/usr/share/fonts/truetype/sand-box/google/Orbitron/Orbitron-VariableFont_wght.ttf",size)
    try: wf.set_variation_by_name("Bold")
    except Exception: pass
    wb=td.textbbox((0,0),WORD,font=wf)
    if wb[2]-wb[0]<=tw: break
    size-=1
ww,wh=wb[2]-wb[0],wb[3]-wb[1]
td.text(((W-ww)/2-wb[0],(H-wh)/2-wb[1]),WORD,font=wf,fill=255)
print("word size",size,"width",ww,"of",tw)

def node(x,y,r=13): d.ellipse((x-r,y-r,x+r,y+r),outline=255,width=6)
def via(x,y,r=8): d.ellipse((x-r,y-r,x+r,y+r),fill=255)

for side in (-1,1):
    edge = 0 if side<0 else W
    inner = L if side<0 else R
    # middle bus: straight lines into the word, staggered ends
    ends=[150,95,60,95,150]
    for i,g in enumerate(ends):
        y=cy-2*s+i*s
        x_end=inner+side*g
        d.line((edge,y,x_end,y),fill=255,width=6); node(x_end+side*13,y)
    # top & bottom buses: come in high/low, 45-degree bend toward the word
    for vdir in (-1,1):
        n=4
        y_in0=cy+vdir*520
        y_out0=cy+vdir*180
        for i in range(n):
            y_in=y_in0 - vdir*i*s      # outer line farthest
            y_out=y_out0 + vdir*(n-1-i)*s*0  # placeholder
            y_out=cy+vdir*(150+ (n-1-i)*s)
            drop=abs(y_in-y_out)
            bx=(inner+side*(380+ i*0)) - side*0
            # bend start x shifted so parallel lines keep spacing
            bend_start = inner + side*(340+drop) + side*(i*s*k)
            bend_end_x = bend_start - side*drop
            x_end = inner + side*(110 + (n-1-i)*45)
            pts=[(edge,y_in),(bend_start,y_in),(bend_end_x,y_out),(x_end,y_out)]
            d.line(pts,fill=255,width=6,joint="curve")
            node(x_end+side*13,y_out)
            if i%2==0: via(bend_start,y_in)
    # a few short stubs near edges for texture
    for j,y in enumerate((cy-650,cy-610,cy+610,cy+650)):
        x0=edge; x1=edge-side*(220+j*60)
        d.line((x0,y,x1,y),fill=255,width=5); node(x1-side*13,y,11)

fade=Image.new("L",(W,H),0); fd=ImageDraw.Draw(fade)
for x in range(W):
    t=1-abs(x-cx)/cx; fd.line((x,0,x,H),fill=int(70+185*(t**0.5)))
tr=ImageChops.multiply(tr,fade)
img=Image.new("RGBA",(W,H),DARK+(255,))
g=Image.new("RGBA",(W,H),BLUE+(0,)); g.putalpha(tr.filter(ImageFilter.GaussianBlur(14)))
img=Image.alpha_composite(img,g)
l=Image.new("RGBA",(W,H),BLUE+(0,)); l.putalpha(tr); img=Image.alpha_composite(img,l)
tg=Image.new("RGBA",(W,H),BLUE+(0,)); tg.putalpha(tm.filter(ImageFilter.GaussianBlur(28)).point(lambda v:int(v*0.8)))
img=Image.alpha_composite(img,tg)
wt=Image.new("RGBA",(W,H),(240,244,255,0)); wt.putalpha(tm); img=Image.alpha_composite(img,wt)
img.convert("RGB").save("cipher-splash-v1.14.png"); print("ok")
