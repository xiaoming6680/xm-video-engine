"""歌词切词和转写：让只认拉丁字母的对齐模型（MMS_FA）也能对中文、日文、韩文。

  from romanize import tokenize, romanize, pick_lines
  tokenize("我们 run away")      # ['我', '们', 'run', 'away']：拉丁字母按空格切，汉字、假名、韩文一个字一个词，标点粘到旁边的词上
  romanize("们")                  # 'men'：汉字转无调拼音（pypinyin），假名转平文式罗马字，韩文按国语罗马字，拉丁字母原样小写
  pick_lines(lrc_text)            # [(秒, 原文, 译文)]：网易云内嵌 LRC 同一个时间戳常有原文和中文翻译两行，挑出原文

做法照 NCM-BetterMV 对齐包的文档（docs/ALIGNER.md，同一个 MMS-FA 模型；中文一首实测词首误差中位 0.08 s），代码是这里重写的。
已知局限：日文汉字按普通话拼音转，位置大致对、不精确（假名准）；数字、符号转不出字母，对齐时跳过，事后按前后词插值。
"""
import re
import unicodedata

HAN = "㐀-鿿豈-﫿"
KANA = "぀-ヿ"
HANGUL = "가-힯"
CJK = HAN + KANA + HANGUL
_CJK_RE = re.compile(f"[{CJK}]")
_KANA_RE = re.compile(f"[{KANA}]")
_HANGUL_RE = re.compile(f"[{HANGUL}]")
_HAN_RE = re.compile(f"[{HAN}]")
_LATIN_RE = re.compile(r"[A-Za-z]")
# 小假名和长音号不单独成词，粘在前一个字上（きゃ、ちょっ、ラー）
_SMALL = set("ぁぃぅぇぉゃゅょゎっァィゥェォャュョヮッヵヶー")
_TOKEN_RE = re.compile(f"[{CJK}]|[^\\s{CJK}]+")


def _is_punct(s):
    return all(unicodedata.category(c)[0] in "PS" for c in s)


def _is_opening(s):
    return all(unicodedata.category(c) in ("Ps", "Pi") for c in s)


def tokenize(text):
    """一行歌词 → 词：拉丁字母按空格切，汉字 / 假名 / 韩文一个字一个词；小假名、长音号粘到前一个字；标点粘到旁边的词。"""
    out, pending = [], ""
    for m in _TOKEN_RE.finditer(text):
        s = m.group(0)
        if s in _SMALL and out and _CJK_RE.match(out[-1][-1]):
            out[-1] += s
        elif _is_punct(s):
            if _is_opening(s) or not out:
                pending += s
            else:
                out[-1] += s
        else:
            out.append(pending + s)
            pending = ""
    if pending and out:
        out[-1] += pending
    return out


# ---- 假名 → 平文式罗马字 --------------------------------------------------------------------------------------------
_GOJUON = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "o", "ん": "n",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ゔ": "vu", "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o", "ゎ": "wa",
}
_YOON = {"ゃ": "a", "ゅ": "u", "ょ": "o"}


def _hira(ch):
    o = ord(ch)
    if 0x30A1 <= o <= 0x30F6:  # 片假名 → 平假名
        return chr(o - 0x60)
    return {"ヵ": "か", "ヶ": "け"}.get(ch, ch)


def kana_romaji(s):
    out = []          # 每个假名一段罗马字
    geminate = False  # っ：下一个音的辅音重复
    for ch in s:
        h = _hira(ch)
        if h == "っ":
            geminate = True
            continue
        if h == "ー":  # 长音：重复前一个元音
            if out and out[-1] and out[-1][-1] in "aiueo":
                out.append(out[-1][-1])
            continue
        if h in _YOON and out and out[-1].endswith("i") and len(out[-1]) >= 2:
            prev = out.pop()
            out.append((prev[:-1] if prev.endswith(("shi", "chi", "ji")) else prev[:-1] + "y") + _YOON[h])
            continue
        r = _GOJUON.get(h) or _YOON.get(h, "")
        if geminate and r:
            r = ("t" if r.startswith("ch") else r[0]) + r if r[0] not in "aiueon" else r
            geminate = False
        out.append(r)
    return "".join(out)


# ---- 韩文 → 国语罗马字（每个音节按 初声 + 中声 + 终声的代表音）------------------------------------------------------
_INITIAL = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
_MEDIAL = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu",
           "eu", "ui", "i"]
_FINAL = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng",
          "t", "t", "k", "t", "p", "t"]


def hangul_romaji(ch):
    o = ord(ch) - 0xAC00
    return _INITIAL[o // 588] + _MEDIAL[(o % 588) // 28] + _FINAL[o % 28]


_pinyin = None


def romanize(token):
    """一个词 → 对齐模型认得的字母（a–z 和词中的撇号）；转不出来的（数字、符号）返回空串。"""
    global _pinyin
    s = token
    if _HAN_RE.search(s):
        if _pinyin is None:
            from pypinyin import lazy_pinyin
            _pinyin = lazy_pinyin
        s = "".join(_pinyin(s, v_to_u=True))
    if _KANA_RE.search(s):
        s = re.sub(f"[{KANA}]+", lambda m: kana_romaji(m.group(0)), s)
    if _HANGUL_RE.search(s):
        s = re.sub(f"[{HANGUL}]", lambda m: hangul_romaji(m.group(0)), s)
    s = unicodedata.normalize("NFKD", s.lower().replace("’", "'"))
    s = "".join(c for c in s if c in "abcdefghijklmnopqrstuvwxyz'")
    return s.strip("'")


def is_cjk(text):
    return bool(_CJK_RE.search(text))


# ---- LRC：挑原文行 ---------------------------------------------------------------------------------------------------
_STAMP = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
_CREDIT = re.compile(r"^\s*(作词|作詞|作曲|编曲|編曲|词|詞|曲|制作人|製作人|监制|混音|母带|录音|和声|吉他|贝斯|鼓|弦乐|出品|发行|"
                     r"OP|SP|Lyrics|Music|Composer|Arranger|Producer)\s*[:：]", re.I)


def _han_share(s):
    letters = [c for c in s if not c.isspace() and not _is_punct(c)]
    return sum(1 for c in letters if _HAN_RE.match(c)) / max(1, len(letters))


def _original(rows):
    """同一个时间戳的几行 → (原文, 译文)。只有一行就是原文；有假名 / 韩文的是原文（日、韩歌配中文翻译）；
    一行以汉字为主、一行不是，汉字那行是翻译（英文歌配中文翻译）；都分不出就按顺序，第一行是原文。"""
    if len(rows) == 1:
        return rows[0], ""
    for r in rows:
        if _KANA_RE.search(r) or _HANGUL_RE.search(r):
            return r, next((x for x in rows if x is not r and _han_share(x) > 0.5), "")
    han = [r for r in rows if _han_share(r) > 0.5]
    other = [r for r in rows if _han_share(r) <= 0.5 and _LATIN_RE.search(r)]
    if han and other:
        return other[0], han[0]
    return rows[0], rows[1] if _han_share(rows[1]) > 0.5 else ""


def pick_lines(lrc_text):
    """内嵌 LRC 文本 → [(秒, 原文, 译文 或 '')]，按时间排；空行（间奏标记）也留着，原文为 ''，给上一句当边界。
    一行有几个时间戳（[00:10.00][00:40.00]同一句）就展开成几句；作词作曲这类署名行去掉。"""
    groups = {}
    for raw in lrc_text.splitlines():
        stamps = list(_STAMP.finditer(raw))
        if not stamps:
            continue
        txt = raw[stamps[-1].end():].strip()
        for m in stamps:
            t = round(int(m.group(1)) * 60 + float(m.group(2)), 3)
            groups.setdefault(t, []).append(txt)
    out = []
    for t in sorted(groups):
        rows = [r for r in groups[t] if r and not _CREDIT.match(r) and r != "//"]
        if not rows:
            out.append((t, "", ""))
            continue
        orig, trans = _original(rows)
        out.append((t, orig, trans))
    return out
