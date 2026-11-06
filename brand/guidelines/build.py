import math, os, random, json, io
import cairosvg
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT='/tmp/kit/QRB-brand-kit'
INK='#0E1320'; DEEP='#0A0E18'; SURF='#161C2C'; LINE='#262E42'; TEXT='#E8EAF0'; MUTED='#8A93A6'; BODY='#B4BAC8'
VIOLET='#A78BFA'; AMBER='#F2A93B'; VIOLET_L='#6D4AE0'; AMBER_L='#C9780A'; PAPER='#F6F7FB'
FD='/usr/share/fonts/opentype/inter/'
WM=FD+'InterDisplay-SemiBold.otf'; DESC=FD+'Inter-Medium.otf'; REG=FD+'Inter-Regular.otf'; JBM='/tmp/JBM-500.ttf'

def d(p): os.makedirs(os.path.join(OUT,p),exist_ok=True); return os.path.join(OUT,p)

# ---------- mark ----------
def mark(ring,core,bind,small=False,tx=0,ty=0,s=1):
    g=f'<g transform="translate({tx} {ty}) scale({s})">'
    if small:
        g+=f'<circle cx="27" cy="27" r="17" fill="none" stroke="{ring}" stroke-width="9"/>'
        g+=f'<line x1="41" y1="41" x2="50" y2="50" stroke="{bind}" stroke-width="9" stroke-linecap="round"/>'
        g+=f'<circle cx="53" cy="53" r="9" fill="{bind}"/>'
    else:
        g+=f'<circle cx="28" cy="28" r="18" fill="none" stroke="{ring}" stroke-width="6"/>'
        if core: g+=f'<circle cx="28" cy="28" r="4.5" fill="{core}"/>'
        g+=f'<line x1="41" y1="41" x2="50" y2="50" stroke="{bind}" stroke-width="6" stroke-linecap="round"/>'
        g+=f'<circle cx="53" cy="53" r="7" fill="{bind}"/>'
    return g+'</g>'

def svg(w,h,body,bg=None,title='QRB'):
    b=f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}"><title>{title}</title>{b}{body}</svg>'

# ---------- text to outlines ----------
_fonts={}
def text_path(txt,font,size,x,y,fill,track=0.0):
    f=_fonts.setdefault(font,TTFont(font)); gs=f.getGlyphSet(); cmap=f.getBestCmap(); upm=f['head'].unitsPerEm
    sc=size/upm; pen=SVGPathPen(gs); cx=0
    for ch in txt:
        gn=cmap[ord(ch)]; tp=TransformPen(pen,(sc,0,0,-sc,x+cx,y)); gs[gn].draw(tp)
        cx+=gs[gn].width*sc+track*size
    return f'<path d="{pen.getCommands()}" fill="{fill}"/>', cx-track*size
def text_w(txt,font,size,track=0.0): return text_path(txt,font,size,0,0,'#000',track)[1]

# ---------- logo SVGs ----------
variants={
 'color-on-dark':(TEXT,AMBER,VIOLET,MUTED),
 'color-on-light':(INK,AMBER_L,VIOLET_L,'#4B5468'),
 'mono-white':(TEXT,TEXT,TEXT,TEXT),
 'mono-ink':(INK,INK,INK,INK),
 'mono-violet':(VIOLET,VIOLET,VIOLET,VIOLET),
 'mono-black':('#000000','#000000','#000000','#000000'),
}
L=d('logo/svg'); P=d('logo/png')
def write(path,s,pngs=()):
    open(path,'w').write(s)
    for w,pp in pngs: cairosvg.svg2png(bytestring=s.encode(),write_to=pp,output_width=w)

for v,(r,c,b,m) in variants.items():
    s=svg(64,64,mark(r,c,b),title='QRB mark')
    write(f'{L}/qrb-mark-{v}.svg',s,[(1024,f'{P}/qrb-mark-{v}-1024.png'),(256,f'{P}/qrb-mark-{v}-256.png')])
    s=svg(64,64,mark(r,c,b,small=True),title='QRB mark, small')
    write(f'{L}/qrb-mark-small-{v}.svg',s)
    # horizontal lockup
    wm,ww=text_path('QRB',WM,56,82,50.4,r,-0.035)
    W=math.ceil(82+ww+2)
    s=svg(W,64,mark(r,c,b)+wm,title='QRB')
    write(f'{L}/qrb-lockup-{v}.svg',s,[(W*16,f'{P}/qrb-lockup-{v}-{W*16}w.png')])
    # descriptor lockup
    wm,ww=text_path('QRB',WM,48,82,42,r,-0.035)
    ds,dw=text_path('QUANTUM RESOURCE BINDER',DESC,10.5,83,60,m,0.14)
    W=math.ceil(82+max(ww,dw)+2)
    s=svg(W,64,mark(r,c,b)+wm+ds,title='QRB, Quantum Resource Binder')
    write(f'{L}/qrb-lockup-descriptor-{v}.svg',s,[(W*12,f'{P}/qrb-lockup-descriptor-{v}-{W*12}w.png')])
    # stacked
    wm,ww=text_path('QRB',WM,40,0,0,r,-0.035)
    wm,ww=text_path('QRB',WM,40,(100-ww)/2,112,r,-0.035)
    s=svg(100,120,mark(r,c,b,tx=18,ty=0)+wm,title='QRB')
    write(f'{L}/qrb-stacked-{v}.svg',s,[(1000,f'{P}/qrb-stacked-{v}-1000w.png')])
    # wordmark only
    wm,ww=text_path('QRB',WM,56,1,50.4,r,-0.035)
    s=svg(math.ceil(ww+2),64,wm,title='QRB')
    write(f'{L}/qrb-wordmark-{v}.svg',s)

# ---------- app icons ----------
A=d('app')
def tile(size,bg,r,c,b,scale=0.64,small=False,radius=0):
    m=size*scale/64; off=(size-64*m)/2+ (size*0.012)  # optical nudge toward visual center
    rect=f'<rect width="{size}" height="{size}" rx="{radius}" fill="{bg}"/>' if bg else ''
    return svg(size,size,rect+mark(r,c,b,small,tx=off-size*0.01,ty=off-size*0.01,s=m),title='QRB app icon')
icons={'dark':(INK,TEXT,AMBER,VIOLET),'violet':(VIOLET,INK,INK,INK),'mono':(INK,TEXT,TEXT,TEXT)}
for k,(bg,r,c,b) in icons.items():
    s=tile(1024,bg,r,c,b)
    write(f'{A}/app-icon-{k}-1024.svg',s,[(1024,f'{A}/app-icon-{k}-1024.png')])
ios=d('app/ios'); 
for sz in [1024,180,167,152,120,87,80,76,60,58,40,29,20]:
    small=sz<=40
    cairosvg.svg2png(bytestring=tile(1024,INK,TEXT,None if small else AMBER,VIOLET,small=small,scale=0.66 if small else 0.64).encode(),write_to=f'{ios}/AppIcon-{sz}.png',output_width=sz)
an=d('app/android')
# adaptive: 108dp canvas, safe zone 66dp -> mark ~ 0.5 of canvas
cairosvg.svg2png(bytestring=tile(432,None,TEXT,AMBER,VIOLET,scale=0.5).encode(),write_to=f'{an}/ic_launcher_foreground.png',output_width=432)
cairosvg.svg2png(bytestring=tile(432,None,TEXT,TEXT,TEXT,scale=0.5).encode(),write_to=f'{an}/ic_launcher_monochrome.png',output_width=432)
Image.new('RGB',(432,432),INK).save(f'{an}/ic_launcher_background.png')
for name,sz in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
    cairosvg.svg2png(bytestring=tile(1024,INK,TEXT,AMBER,VIOLET,radius=512).encode(),write_to=f'{an}/ic_launcher_round-{name}-{sz}.png',output_width=sz)
cairosvg.svg2png(bytestring=tile(1024,INK,TEXT,AMBER,VIOLET).encode(),write_to=f'{an}/play-store-512.png',output_width=512)

# ---------- web ----------
Wb=d('web')
cairosvg.svg2png(bytestring=tile(1024,INK,TEXT,AMBER,VIOLET).encode(),write_to=f'{Wb}/apple-touch-icon.png',output_width=180)
cairosvg.svg2png(bytestring=tile(1024,INK,TEXT,AMBER,VIOLET).encode(),write_to=f'{Wb}/icon-192.png',output_width=192)
cairosvg.svg2png(bytestring=tile(1024,INK,TEXT,AMBER,VIOLET).encode(),write_to=f'{Wb}/icon-512.png',output_width=512)
cairosvg.svg2png(bytestring=tile(1024,INK,TEXT,AMBER,VIOLET,scale=0.5).encode(),write_to=f'{Wb}/icon-maskable-512.png',output_width=512)
fav=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.r{{stroke:{INK}}}.b{{stroke:{VIOLET_L};fill:{VIOLET_L}}}@media (prefers-color-scheme:dark){{.r{{stroke:{TEXT}}}.b{{stroke:{VIOLET};fill:{VIOLET}}}}}</style><circle class="r" cx="27" cy="27" r="17" fill="none" stroke-width="9"/><line class="b" x1="41" y1="41" x2="50" y2="50" stroke-width="9" stroke-linecap="round"/><circle class="b" cx="53" cy="53" r="9" stroke="none"/></svg>'''
open(f'{Wb}/favicon.svg','w').write(fav)
ims=[]
for sz in (16,32,48):
    b=io.BytesIO(); cairosvg.svg2png(bytestring=tile(64,INK,TEXT,None if sz<32 else AMBER,VIOLET,small=sz<32,scale=0.8,radius=12).encode(),write_to=b,output_width=sz); ims.append(Image.open(b).convert('RGBA'))
ims[-1].save(f'{Wb}/favicon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48)],append_images=ims[:-1])
json.dump({"name":"QRB · Quantum Resource Binder","short_name":"QRB","start_url":"/","display":"standalone","background_color":INK,"theme_color":INK,
 "icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png"},{"src":"/icon-512.png","sizes":"512x512","type":"image/png"},{"src":"/icon-maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}]},open(f'{Wb}/site.webmanifest','w'),indent=2)
open(f'{Wb}/head-snippet.html','w').write('''<!-- QRB: paste in <head>; files from /web at the site root -->
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0E1320">
<meta property="og:title" content="QRB · Quantum Resource Binder">
<meta property="og:description" content="Declare what matters. Get the right QPU for it.">
<meta property="og:image" content="/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
''')

# ---------- ASCII ----------
def ascii_layers(W,H,noise=0.10,seed=7):
    random.seed(seed)
    def seg(px,py,ax,ay,bx,by):
        vx,vy=bx-ax,by-ay;t=max(0,min(1,((px-ax)*vx+(py-ay)*vy)/(vx*vx+vy*vy)));return math.hypot(px-(ax+t*vx),py-(ay+t*vy))
    def ch(x):
        for th,c in [(-1.4,'@'),(-0.5,'%'),(0.3,'#'),(0.9,'*'),(1.5,'+'),(2.1,'='),(2.8,'-'),(3.6,':')]:
            if x<=th: return c
    A=[];V=[];B=[]
    for r in range(H):
        a=v=bg=''
        for c in range(W):
            x=(c+0.5)/W*72-4; y=(r+0.5)/H*68-2; dd=math.hypot(x-28,y-28)
            da=min(abs(dd-18)-3.2,dd-4.2); dv=min(seg(x,y,41,41,50,50)-3.2,math.hypot(x-53,y-53)-7)
            ca,cv=ch(da),ch(dv)
            if cv and (not ca or dv<da): a+=' ';v+=cv;bg+=' '
            elif ca: a+=ca;v+=' ';bg+=' '
            else: a+=' ';v+=' ';bg+=('.' if random.random()<noise else ' ')
        A.append(a);V.append(v);B.append(bg)
    return A,V,B
A_,V_,B_=ascii_layers(72,34)
M=d('media')
open(f'{M}/qrb-ascii-mark.txt','w').write('\n'.join(
    ''.join(a if a!=' ' else (v if v!=' ' else ' ') for a,v in zip(ra,rv)).rstrip() for ra,rv in zip(A_,V_)))

def hexrgb(h,a=255): h=h.lstrip('#'); return tuple(int(h[i:i+2],16) for i in (0,2,4))+(a,)
def ascii_img(cell_w, A,V,B, bgdots=True):
    cell_w=int(cell_w)
    font=ImageFont.truetype(JBM,int(cell_w*1.66)); lh=int(cell_w*1.9)
    W=len(A[0])*cell_w; H=len(A)*lh
    base=Image.new('RGBA',(W,H),(0,0,0,0))
    layers=[]
    for rows,col,glow in [(B,'#2E3650',False),(A,AMBER,True),(V,VIOLET,True)]:
        if not bgdots and rows is B: continue
        im=Image.new('RGBA',(W,H),(0,0,0,0)); dr=ImageDraw.Draw(im)
        for i,row in enumerate(rows):
            for j,c in enumerate(row):
                if c!=' ': dr.text((j*cell_w,i*lh),c,font=font,fill=hexrgb(col))
        if glow:
            g=im.filter(ImageFilter.GaussianBlur(cell_w*0.9)); 
            base=Image.alpha_composite(base,g)
        base=Image.alpha_composite(base,im)
    return base
big=ascii_img(28,A_,V_,B_,bgdots=False); big.save(f'{M}/qrb-ascii-mark-transparent.png')

# ---------- composites ----------
def mark_png(size,r=TEXT,c=AMBER,b=VIOLET,small=False):
    bio=io.BytesIO(); cairosvg.svg2png(bytestring=svg(64,64,mark(r,c,b,small)).encode(),write_to=bio,output_width=size); return Image.open(bio).convert('RGBA')
def svg_png(s,w):
    bio=io.BytesIO(); cairosvg.svg2png(bytestring=s.encode(),write_to=bio,output_width=w); return Image.open(bio).convert('RGBA')
def lockup_png(height,v='color-on-dark',desc=False):
    s=open(f'{L}/qrb-lockup{"-descriptor" if desc else ""}-{v}.svg').read()
    w=int(s.split('viewBox="0 0 ')[1].split()[0]); return svg_png(s,int(w*height/64))
def txt(im,xy,t,font,size,fill,anchor='la',spacing=0):
    dr=ImageDraw.Draw(im); f=ImageFont.truetype(font,size); dr.multiline_text(xy,t,font=f,fill=hexrgb(fill),anchor=anchor,spacing=spacing)
def canvas(w,h,col=INK): return Image.new('RGBA',(w,h),hexrgb(col))
def place_ascii(im,cell,cx,cy,noise=0.10):
    A,V,B=ascii_layers(72,34,noise)
    a=ascii_img(cell,A,V,B); im.alpha_composite(a,(int(cx-a.width/2),int(cy-a.height/2)))
def dots(im,density=0.05,seed=3,step=14):
    random.seed(seed); dr=ImageDraw.Draw(im)
    for y in range(0,im.height,step):
        for x in range(0,im.width,step//2*1+3):
            if random.random()<density: dr.text((x,y),'.',font=ImageFont.truetype(JBM,12),fill=hexrgb('#262E42'))

# OG 1200x630
im=canvas(1200,630); dots(im)
place_ascii(im,8,950,315,0.0)
im.alpha_composite(lockup_png(56),(72,72))
txt(im,(72,250),'Declare what matters.\nGet the right QPU for it.',WM,54,TEXT,spacing=6)
txt(im,(72,420),'Give QRB an OpenQASM 3 circuit and your preferences.\nIt returns the optimal IBM Quantum or Amazon Braket QPU.',REG,22,BODY,spacing=8)
txt(im,(72,560),'QRB · Quantum Resource Binder',JBM,18,MUTED)
im.convert('RGB').save(f'{M}/og-image-1200x630.png')
# GitHub social preview 1280x640
im=canvas(1280,640); dots(im); place_ascii(im,10,960,320,0.0)
im.alpha_composite(lockup_png(64,desc=True),(80,80))
txt(im,(80,280),'Declare what matters.\nGet the right QPU for it.',WM,58,TEXT,spacing=6)
txt(im,(80,560),'ICSOC 2026 · SCORE Lab, Universidad de Sevilla · Apache-2.0',JBM,18,MUTED)
im.convert('RGB').save(f'{M}/github-social-preview-1280x640.png')
# X header 1500x500 (avatar overlaps bottom-left: keep content right)
im=canvas(1500,500); dots(im); place_ascii(im,7,1220,250,0.0)
txt(im,(520,170),'Declare what matters.\nGet the right QPU for it.',WM,48,TEXT,spacing=6)
txt(im,(520,320),'QRB · Quantum Resource Binder',JBM,18,MUTED)
im.convert('RGB').save(f'{M}/x-header-1500x500.png')
# LinkedIn banner 1584x396
im=canvas(1584,396); dots(im); place_ascii(im,6,1360,198,0.0)
im.alpha_composite(lockup_png(48,desc=True),(480,110))
txt(im,(480,220),'Declare what matters. Get the right QPU for it.',WM,34,TEXT)
im.convert('RGB').save(f'{M}/linkedin-banner-1584x396.png')
# README banners
for mode,bg,v,fg,mu in [('dark',INK,'color-on-dark',TEXT,MUTED),('light',PAPER,'color-on-light',INK,'#4B5468')]:
    im=canvas(1280,320,bg)
    if mode=='dark': dots(im); place_ascii(im,5,1090,160,0.0)
    else: im.alpha_composite(svg_png(open(f'{L}/qrb-mark-color-on-light.svg').read(),220),(980,50))
    im.alpha_composite(lockup_png(72,v,desc=True),(80,90))
    txt(im,(80,232),'Declare what matters. Get the right QPU for it.',REG,24,mu)
    im.convert('RGB').save(f'{M}/readme-banner-{mode}-1280x320.png')
# Avatars
for name,bg,r,c,b in [('dark',INK,TEXT,AMBER,VIOLET),('violet',VIOLET,INK,INK,INK),('mono',INK,TEXT,TEXT,TEXT)]:
    s=tile(800,bg,r,c,b,scale=0.56); svg_png(s,800).convert('RGB').save(f'{M}/avatar-{name}-800.png')
# Slide title 1920x1080 + 404/loading ascii poster
im=canvas(1920,1080); dots(im); place_ascii(im,14,1380,540,0.0)
im.alpha_composite(lockup_png(64),(120,120))
txt(im,(120,420),'Declare what matters.\nGet the right QPU for it.',WM,84,TEXT,spacing=10)
txt(im,(120,900),'[TALK TITLE] · [SPEAKER] · [VENUE, DATE]',JBM,26,MUTED)
im.convert('RGB').save(f'{M}/slide-title-1920x1080.png')
im=canvas(1080,1080); dots(im,0.08); place_ascii(im,13,540,500,0.08)
txt(im,(540,940),'QRB',WM,48,TEXT,anchor='ma')
im.convert('RGB').save(f'{M}/ascii-poster-1080.png')
print('done')
