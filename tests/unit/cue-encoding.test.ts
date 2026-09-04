import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import { decodeCueBytes, encodeCueText } from "../../electron/services/cue-encoding";

describe("CUE encoding", () => {
  it("detects UTF-8 with and without a byte-order mark", () => {
    const plain = decodeCueBytes(Buffer.from('TITLE "Blue Train"', "utf8"));
    const bom = decodeCueBytes(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('TITLE "Blue Train"', "utf8")
    ]));

    expect(plain).toEqual({ encoding: "utf8", text: 'TITLE "Blue Train"' });
    expect(bom).toEqual({ encoding: "utf8-bom", text: 'TITLE "Blue Train"' });
  });

  it("decodes a confidently detected GBK CUE and retains the compatible GB18030 choice", () => {
    const source = [
      'REM GENRE "流行音乐"',
      'PERFORMER "周杰伦"',
      'TITLE "七里香"',
      'FILE "七里香.flac" WAVE',
      '  TRACK 01 AUDIO',
      '    TITLE "我的地盘"',
      '    INDEX 01 00:00:00',
      '  TRACK 02 AUDIO',
      '    TITLE "七里香"',
      '    INDEX 01 04:59:00'
    ].join("\n");

    const decoded = decodeCueBytes(iconv.encode(source, "gbk"));

    expect(decoded.encoding).toBe("gbk");
    expect(decoded.text).toBe(source);
    expect(decoded.candidateEncodings).toEqual(expect.arrayContaining(["gbk", "gb18030"]));
  });

  it.each([
    ["big5", [
      'REM GENRE "流行音樂"',
      'PERFORMER "周杰倫"',
      'TITLE "七里香"',
      'FILE "七里香.flac" WAVE',
      '  TRACK 01 AUDIO',
      '    TITLE "我的地盤"',
      '    INDEX 01 00:00:00'
    ].join("\n")],
    ["shift-jis", [
      'REM GENRE "ポップス"',
      'PERFORMER "宇多田ヒカル"',
      'TITLE "初恋"',
      'FILE "初恋.flac" WAVE',
      '  TRACK 01 AUDIO',
      '    TITLE "あなた"',
      '    INDEX 01 00:00:00'
    ].join("\n")]
  ] as const)("detects and round-trips supported %s text", (encoding, source) => {
    const bytes = encodeCueText(source, encoding);
    expect(decodeCueBytes(bytes)).toMatchObject({ encoding, text: source });
    expect(iconv.decode(bytes, encoding === "shift-jis" ? "shift_jis" : encoding)).toBe(source);
  });

  it("distinguishes a four-byte GB18030 sequence from its GBK subset", () => {
    const source = 'PERFORMER "𠮷野家"\nTITLE "扩展字符"';

    expect(decodeCueBytes(iconv.encode(source, "gb18030"))).toMatchObject({
      encoding: "gb18030",
      text: source
    });
  });

  it("exposes supported previews when a short legacy sample is ambiguous", () => {
    const decoded = decodeCueBytes(iconv.encode('TITLE "中文"', "gbk"));

    expect(decoded.candidateEncodings).toEqual(expect.arrayContaining(["gbk", "big5", "shift-jis"]));
  });
});
