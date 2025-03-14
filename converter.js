/**
 * PLYファイルをsplatv形式に変換するためのユーティリティ関数
 */

// Float値をHalf形式に変換
function floatToHalf(float) {
  const _floatView = new Float32Array(1);
  const _int32View = new Int32Array(_floatView.buffer);
  
  _floatView[0] = float;
  var f = _int32View[0];
  var sign = (f >> 31) & 0x0001;
  var exp = (f >> 23) & 0x00ff;
  var frac = f & 0x007fffff;
  var newExp;
  if (exp == 0) {
    newExp = 0;
  } else if (exp < 113) {
    newExp = 0;
    frac |= 0x00800000;
    frac = frac >> (113 - exp);
    if (frac & 0x01000000) {
      newExp = 1;
      frac = 0;
    }
  } else if (exp < 142) {
    newExp = exp - 112;
  } else {
    newExp = 31;
    frac = 0;
  }
  return (sign << 15) | (newExp << 10) | (frac >> 13);
}

// 2つのFloat値をpackして1つのUint32にする
function packHalf2x16(x, y) {
  return (floatToHalf(x) | (floatToHalf(y) << 16)) >>> 0;
}

/**
 * PLYバッファを処理してsplatv形式に変換する
 * @param {ArrayBuffer} inputBuffer - 入力PLYファイルのバッファ
 * @returns {Object} 処理結果を含むオブジェクト
 */
function processPlyBuffer(inputBuffer) {
  const ubuf = new Uint8Array(inputBuffer);
  // 10KB ought to be enough for a header...
  const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
  const header_end = "end_header\n";
  const header_end_index = header.indexOf(header_end);
  if (header_end_index < 0) throw new Error("Unable to read .ply file header");
  const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
  console.log("Vertex Count", vertexCount);
  let row_offset = 0,
    offsets = {},
    types = {};
  const TYPE_MAP = {
    double: "getFloat64",
    int: "getInt32",
    uint: "getUint32",
    float: "getFloat32",
    short: "getInt16",
    ushort: "getUint16",
    uchar: "getUint8",
  };
  for (let prop of header
    .slice(0, header_end_index)
    .split("\n")
    .filter((k) => k.startsWith("property "))) {
    const [p, type, name] = prop.split(" ");
    const arrayType = TYPE_MAP[type] || "getInt8";
    types[name] = arrayType;
    offsets[name] = row_offset;
    row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
  }

  console.log("Bytes per row", row_offset, types, offsets);

  let dataView = new DataView(inputBuffer, header_end_index + header_end.length);
  let row = 0;
  const attrs = new Proxy(
    {},
    {
      get(target, prop) {
        if (!types[prop]) throw new Error(prop + " not found");
        return dataView[types[prop]](row * row_offset + offsets[prop], true);
      },
    }
  );

  console.time("calculate importance");
  let sizeList = new Float32Array(vertexCount);
  let sizeIndex = new Uint32Array(vertexCount);
  for (row = 0; row < vertexCount; row++) {
    sizeIndex[row] = row;
    if (!types["scale_0"]) continue;
    const size = Math.exp(attrs.scale_0) * Math.exp(attrs.scale_1) * Math.exp(attrs.scale_2);
    const opacity = 1 / (1 + Math.exp(-attrs.opacity));
    sizeList[row] = size * opacity;
  }
  console.timeEnd("calculate importance");

  for (let type in types) {
    let min = Infinity,
      max = -Infinity;
    for (row = 0; row < vertexCount; row++) {
      sizeIndex[row] = row;
      min = Math.min(min, attrs[type]);
      max = Math.max(max, attrs[type]);
    }
    console.log(type, min, max);
  }

  console.time("sort");
  sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
  console.timeEnd("sort");

  const position_buffer = new Float32Array(3 * vertexCount);

  var texwidth = 1024 * 4; // 希望する幅に設定
  var texheight = Math.ceil((4 * vertexCount) / texwidth); // 希望する高さに設定
  var texdata = new Uint32Array(texwidth * texheight * 4); // ピクセル毎に4つのコンポーネント(RGBA)
  var texdata_c = new Uint8Array(texdata.buffer);
  var texdata_f = new Float32Array(texdata.buffer);

  console.time("build buffer");
  for (let j = 0; j < vertexCount; j++) {
    row = sizeIndex[j];

    // x, y, z
    position_buffer[3 * j + 0] = attrs.x;
    position_buffer[3 * j + 1] = attrs.y;
    position_buffer[3 * j + 2] = attrs.z;

    texdata_f[16 * j + 0] = attrs.x;
    texdata_f[16 * j + 1] = attrs.y;
    texdata_f[16 * j + 2] = attrs.z;

    // quaternions
    texdata[16 * j + 3] = packHalf2x16(attrs.rot_0, attrs.rot_1);
    texdata[16 * j + 4] = packHalf2x16(attrs.rot_2, attrs.rot_3);

    // scale
    texdata[16 * j + 5] = packHalf2x16(Math.exp(attrs.scale_0), Math.exp(attrs.scale_1));
    texdata[16 * j + 6] = packHalf2x16(Math.exp(attrs.scale_2), 0);

    // rgb
    texdata_c[4 * (16 * j + 7) + 0] = Math.max(0, Math.min(255, attrs.f_dc_0 * 255));
    texdata_c[4 * (16 * j + 7) + 1] = Math.max(0, Math.min(255, attrs.f_dc_1 * 255));
    texdata_c[4 * (16 * j + 7) + 2] = Math.max(0, Math.min(255, attrs.f_dc_2 * 255));

    // opacity
    texdata_c[4 * (16 * j + 7) + 3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;

    // movement over time
    texdata[16 * j + 8 + 0] = packHalf2x16(attrs.motion_0, attrs.motion_1);
    texdata[16 * j + 8 + 1] = packHalf2x16(attrs.motion_2, attrs.motion_3);
    texdata[16 * j + 8 + 2] = packHalf2x16(attrs.motion_4, attrs.motion_5);
    texdata[16 * j + 8 + 3] = packHalf2x16(attrs.motion_6, attrs.motion_7);
    texdata[16 * j + 8 + 4] = packHalf2x16(attrs.motion_8, 0);

    // rotation over time
    texdata[16 * j + 8 + 5] = packHalf2x16(attrs.omega_0, attrs.omega_1);
    texdata[16 * j + 8 + 6] = packHalf2x16(attrs.omega_2, attrs.omega_3);

    // trbf temporal radial basis function parameters
    texdata[16 * j + 8 + 7] = packHalf2x16(attrs.trbf_center, Math.exp(attrs.trbf_scale));
  }
  console.timeEnd("build buffer");

  console.log("Scene Bytes", texdata.buffer.byteLength);

  return { 
    texdata, 
    texwidth, 
    texheight, 
    vertexCount 
  };
}

/**
 * チャンクデータを読み込むためのユーティリティ
 * @param {ReadableStreamDefaultReader} reader - ストリームリーダー
 * @param {Array} chunks - チャンク情報の配列
 * @param {Function} handleChunk - チャンクを処理するコールバック
 * @returns {Promise} 処理の完了を表すPromise
 */
async function readChunks(reader, chunks, handleChunk) {
  let chunk = chunks.shift();
  let buffer = new Uint8Array(chunk.size);
  let offset = 0;
  while (chunk) {
    let { done, value } = await reader.read();
    if (done) break;
    while (value.length + offset >= chunk.size) {
      buffer.set(value.subarray(0, chunk.size - offset), offset);
      value = value.subarray(chunk.size - offset);
      handleChunk(chunk, buffer.buffer, 0, chunks);
      chunk = chunks.shift();
      if (!chunk) break;
      buffer = new Uint8Array(chunk.size);
      offset = 0;
    }
    if (!chunk) break;
    buffer.set(value, offset);
    offset += value.length;
    handleChunk(chunk, buffer.buffer, buffer.byteLength - offset, chunks);
  }
  if (chunk) handleChunk(chunk, buffer.buffer, 0, chunks);
}

// モジュールとしてエクスポート
export { 
  processPlyBuffer,
  floatToHalf,
  packHalf2x16,
  readChunks
};
