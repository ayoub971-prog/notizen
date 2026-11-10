# Erzeugt js/pdf-metrics.js: Zeichenbreiten (1/1000 em) der PDF-Standardschrift
# Helvetica / Helvetica-Bold fuer WinAnsi-Codes 32..255.
# Quelle der Zahlen: AFM-Dateien von URW Nimbus Sans (metrisch identisch zu Helvetica).
# Nur einmalig noetig; das Ergebnis ist im Projekt enthalten.
import fontTools.agl as agl, sys
def load(path):
    w = {}
    for line in open(path, encoding='latin-1'):
        if line.startswith('C '):
            parts = dict(p.strip().split(' ', 1) for p in line.split(';') if p.strip())
            w[parts['N']] = int(float(parts['WX']))
    return w
base = '/usr/share/fonts/type1/urw-base35/'
out = []
for name, f in (('regular', 'NimbusSans-Regular.afm'), ('bold', 'NimbusSans-Bold.afm')):
    w = load(base + f)
    arr = []
    for code in range(32, 256):
        try:
            uni = bytes([code]).decode('cp1252')
        except UnicodeDecodeError:
            arr.append(w['space']); continue
        g = agl.UV2AGL.get(ord(uni))
        if code == 0xA0: g = 'space'
        if code == 0xAD: g = 'hyphen'
        arr.append(w.get(g, w['space']))
    out.append('  %s: [%s]' % (name, ','.join(map(str, arr))))
js = ('// Automatisch erzeugt mit tools/gen-metrics.py - nicht von Hand aendern.\n'
      '// Zeichenbreiten (in 1/1000 der Schriftgroesse) fuer die PDF-Standardschriften\n'
      '// Helvetica und Helvetica-Bold, Index 0 = WinAnsi-Code 32 ... Index 223 = Code 255.\n'
      '// Kursiv (Oblique) hat dieselben Breiten wie die normale Schrift.\n'
      'export const WIDTHS = {\n' + ',\n'.join(out) + '\n};\n')
open(sys.argv[1], 'w').write(js)
