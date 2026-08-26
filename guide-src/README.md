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

**2ページに収まっているか、作り直すたびに確かめてください。**
項目を増やすと3ページ目に溢れることがあります（`main2.css` の
`.grid` の `gap` や `.tools` の高さで調整できます）。
