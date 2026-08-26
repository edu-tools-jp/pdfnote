# かんたんガイドの作り方

配付用の `PDFノート_かんたんガイド.pdf`（A4・2ページ）のもとになるファイルです。
文面を直したいときは `guide.html` を編集して、下のコマンドで作り直します。

```bash
chromium --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
  --print-to-pdf="PDFノート_かんたんガイド.pdf" --virtual-time-budget=8000 \
  "file://$PWD/guide-src/guide.html"
```

- `guide.html` … 本文。アイコンは先頭の `<symbol>` にまとめてあります
  （アプリの `index.html` と同じ形なので、必要な分をコピーして使えます）。
- `app-screenshot.png` … 1ページ目のイメージ図。実際のアプリの画面です。
  差し替えるときは、この名前で置き換えれば作り直すだけで反映されます
  （ブラウザの画面をそのまま撮ったものです。横 1500〜1900px くらいが目安）。
- `main2.css` … 紙面の体裁。A4・2ページに収まるよう余白を詰めてあります。
- `fonts.css` / `NotoSansJP-*.ttf` … 埋め込む書体（Noto Sans JP を必要な字だけに
  絞ったもの）。PDF に埋め込まれるので、他のPCで開いても同じ見た目になります。

**本文に新しい漢字を足したときは、書体も作り直してください。**
絞り込んである字にしか対応していないので、無い字は別の書体で代用されて
見た目がそろいません。下のコマンドで、いまの本文に合わせて作り直せます。

```bash
# 本文で使っている字を集めて、その字だけの Noto Sans JP をもらってくる
python3 - <<'EOF' > /tmp/chars.txt
import re
h = open('guide-src/guide.html', encoding='utf-8').read()
b = h[h.index('<body'):]
b = re.sub(r'<svg[\s\S]*?</svg>', '', b)
b = re.sub(r'<[^>]+>', '', b)
print(''.join(sorted({c for c in b if ord(c) > 0x20})), end='')
EOF

TXT=$(python3 -c "import urllib.parse;print(urllib.parse.quote(open('/tmp/chars.txt',encoding='utf-8').read(),safe=''))")
curl -s -A "Mozilla/5.0 (Windows NT 6.1)" \
  "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700;900&text=$TXT" -o /tmp/gf.css
python3 - <<'EOF'
import re, subprocess
for w, url in re.findall(r"font-weight:\s*(\d+);\s*src:\s*url\(([^)]+)\)",
                         open('/tmp/gf.css', encoding='utf-8').read()):
    subprocess.run(['curl','-s','-A','Mozilla/5.0 (Windows NT 6.1)', url,
                    '-o', f'guide-src/NotoSansJP-{w}.ttf'], check=True)
EOF
```

なお `⋮` や `⚙` は Noto Sans JP に入っていません。そういう記号は文字で書かずに、
先頭の `<symbol>` のアイコンを使うか、言葉で言い換えてください。

**2ページに収まっているか、作り直すたびに確かめてください。**
項目を増やすと3ページ目に溢れることがあります（`main2.css` の
`.grid` の `gap` や `.tools` の高さで調整できます）。
