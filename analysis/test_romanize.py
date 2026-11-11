"""romanize.py 和 align_words.py 套用规则的单测（不需要模型、不需要音频）：python -m unittest analysis/test_romanize.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from romanize import kana_romaji, pick_lines, romanize, tokenize  # noqa: E402


class Tokenize(unittest.TestCase):
    def test_latin_split_on_spaces(self):
        self.assertEqual(tokenize("hello  world"), ["hello", "world"])

    def test_cjk_one_char_each_latin_kept(self):
        self.assertEqual(tokenize("我们 run away"), ["我", "们", "run", "away"])

    def test_punctuation_joins_neighbour(self):
        self.assertEqual(tokenize("你好，世界！"), ["你", "好，", "世", "界！"])
        self.assertEqual(tokenize("「走」"), ["「走」"])

    def test_small_kana_and_long_mark_join_previous(self):
        self.assertEqual(tokenize("きゃっと"), ["きゃっ", "と"])
        self.assertEqual(tokenize("ラーメン"), ["ラー", "メ", "ン"])

    def test_hangul_one_syllable_each(self):
        self.assertEqual(tokenize("사랑해"), ["사", "랑", "해"])


class Romanize(unittest.TestCase):
    def test_han_to_toneless_pinyin(self):
        self.assertEqual(romanize("们"), "men")
        self.assertEqual(romanize("绿"), "lu")  # ü → u

    def test_kana(self):
        self.assertEqual(kana_romaji("さくら"), "sakura")
        self.assertEqual(kana_romaji("きゃ"), "kya")
        self.assertEqual(kana_romaji("しょ"), "sho")
        self.assertEqual(kana_romaji("きって"), "kitte")
        self.assertEqual(kana_romaji("まっちゃ"), "matcha")
        self.assertEqual(kana_romaji("カード"), "kaado")
        self.assertEqual(romanize("テト"), "teto")

    def test_hangul(self):
        self.assertEqual(romanize("한"), "han")
        self.assertEqual(romanize("국"), "guk")

    def test_latin_and_symbols(self):
        self.assertEqual(romanize("Don't,"), "don't")
        self.assertEqual(romanize("café"), "cafe")
        self.assertEqual(romanize("123"), "")


class PickLines(unittest.TestCase):
    def test_english_with_chinese_translation(self):
        lrc = "[00:01.00]Hello there\n[00:01.00]你好啊\n[00:03.00]Next line\n[00:03.00]下一句"
        self.assertEqual(pick_lines(lrc), [(1.0, "Hello there", "你好啊"), (3.0, "Next line", "下一句")])

    def test_japanese_with_chinese_translation(self):
        lrc = "[00:02.00]东京的夜晚\n[00:02.00]東京の夜"
        self.assertEqual(pick_lines(lrc), [(2.0, "東京の夜", "东京的夜晚")])

    def test_chinese_only_and_credits_and_gaps(self):
        lrc = "[00:00.00]作词 : 某人\n[00:00.50]作曲：某人\n[00:05.00]第一句\n[00:09.00]\n[00:12.00]第二句"
        self.assertEqual(pick_lines(lrc), [(0.0, "", ""), (0.5, "", ""), (5.0, "第一句", ""), (9.0, "", ""), (12.0, "第二句", "")])

    def test_repeated_stamps_expand(self):
        lrc = "[00:10.00][00:40.00]副歌"
        self.assertEqual(pick_lines(lrc), [(10.0, "副歌", ""), (40.0, "副歌", "")])


class Apply(unittest.TestCase):
    def setUp(self):
        import importlib.util
        if importlib.util.find_spec("soundfile") is None:
            self.skipTest("soundfile 没装")
        import align_words
        self.aw = align_words

    def test_low_confidence_keeps_estimate(self):
        r = {"words": [[1.0, 1.2], [1.3, 1.5]], "conf": 0.001}
        self.assertIsNone(self.aw.apply(r, ["我", "们"], 1.0, 5.0))

    def test_unplaced_word_interpolated_and_line_monotonic(self):
        r = {"words": [[1.0, 1.2], None, [2.0, 2.2]], "conf": 0.3}
        t = self.aw.apply(r, ["我", "和", "你"], 1.0, 6.0)
        self.assertAlmostEqual(t[1][0], 1.5)
        self.assertTrue(all(t[i][0] <= t[i + 1][0] for i in range(len(t) - 1)))

    def test_word_far_after_pause_not_believed(self):
        r = {"words": [[1.0, 1.2], [5.0, 5.2]], "conf": 0.3}  # 停了 3.8 s 才来的词不采信，按 0.3 s / 音节接上
        t = self.aw.apply(r, ["我", "们"], 1.0, 9.0)
        self.assertAlmostEqual(t[1][0], 1.3)


if __name__ == "__main__":
    unittest.main()
