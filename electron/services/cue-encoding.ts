import chardet from "chardet";
import iconv from "iconv-lite";
import type { CueEncoding } from "../../shared/types";

export type DecodedCue = {
  encoding: CueEncoding;
  text: string;
  candidateEncodings?: CueEncoding[];
};

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function hasGb18030FourByteSequence(bytes: Buffer): boolean {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] >= 0x81 && bytes[index] <= 0xfe
      && bytes[index + 1] >= 0x30 && bytes[index + 1] <= 0x39
      && bytes[index + 2] >= 0x81 && bytes[index + 2] <= 0xfe
      && bytes[index + 3] >= 0x30 && bytes[index + 3] <= 0x39
    ) {
      return true;
    }
  }
  return false;
}

function mappedEncoding(name: string, bytes: Buffer): CueEncoding | undefined {
  switch (name.toUpperCase().replaceAll("_", "-")) {
    case "UTF-8": return "utf8";
    case "GB18030": return hasGb18030FourByteSequence(bytes) ? "gb18030" : "gbk";
    case "GBK": return "gbk";
    case "BIG5": return "big5";
    case "SHIFT-JIS": return "shift-jis";
    default: return undefined;
  }
}

function iconvEncoding(encoding: CueEncoding): string {
  return encoding === "utf8-bom" ? "utf8" : encoding === "shift-jis" ? "shift_jis" : encoding;
}

export function decodeCueBytes(bytes: Buffer): DecodedCue {
  if (bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    return { encoding: "utf8-bom", text: iconv.decode(bytes.subarray(UTF8_BOM.length), "utf8") };
  }
  if (isUtf8(bytes)) {
    return { encoding: "utf8", text: iconv.decode(bytes, "utf8") };
  }

  const matches = chardet.analyse(bytes);
  const supported = matches
    .map((match) => ({ encoding: mappedEncoding(match.name, bytes), confidence: match.confidence }))
    .filter((match): match is { encoding: CueEncoding; confidence: number } => Boolean(match.encoding));
  const first = supported[0];
  const encoding = first?.encoding ?? "gbk";
  const candidates: CueEncoding[] = [];
  const addCandidate = (candidate: CueEncoding): void => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };
  addCandidate(encoding);
  if (encoding === "gbk") {
    addCandidate("gb18030");
  }
  if (!first || first.confidence < 60) {
    for (const match of supported) {
      addCandidate(match.encoding);
      if (match.encoding === "gbk") {
        addCandidate("gb18030");
      }
    }
  }

  return {
    encoding,
    text: iconv.decode(bytes, iconvEncoding(encoding)),
    ...(candidates.length > 1 ? { candidateEncodings: candidates } : {})
  };
}

export function encodeCueText(text: string, encoding: CueEncoding): Buffer {
  const encoded = iconv.encode(text, iconvEncoding(encoding));
  return encoding === "utf8-bom" ? Buffer.concat([UTF8_BOM, encoded]) : encoded;
}
