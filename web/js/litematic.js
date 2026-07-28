// Litematica (.litematic) NBT structure parser/writer.
// Operates on uncompressed NBT bytes; gzip framing is handled elsewhere (task 8).

import { readNbt, writeNbt, tag, TAG } from "./nbt.js";

export function stateKey(state) {
  return state.id + "|" + JSON.stringify(Object.fromEntries(Object.entries(state.props).sort()));
}

export const AIR = Object.freeze({ id: "minecraft:air", props: {} });

// ---------------------------------------------------------------------------
// Bit-packing (Litematica format: contiguous little-endian bitstream, entries
// may span 64-bit long boundaries -- NOT the padded 1.16+ chunk format).
// ---------------------------------------------------------------------------

function packBlockStates(indices, bits) {
  const totalBits = BigInt(indices.length) * BigInt(bits);
  const longCount = Number((totalBits + 63n) / 64n);
  const longs = new BigInt64Array(longCount);
  let bitPos = 0n;
  for (const idx of indices) {
    const li = Number(bitPos / 64n);
    const off = bitPos % 64n;
    longs[li] = BigInt.asIntN(64, longs[li] | (BigInt(idx) << off));
    const spill = off + BigInt(bits) - 64n;
    if (spill > 0n) {
      longs[li + 1] = BigInt.asIntN(64, BigInt(idx) >> (BigInt(bits) - spill));
    }
    bitPos += BigInt(bits);
  }
  return longs;
}

function unpackBlockStates(longs, bits, count) {
  const out = new Uint32Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  let bitPos = 0n;
  for (let i = 0; i < count; i++) {
    const li = Number(bitPos / 64n);
    const off = bitPos % 64n;
    let v = BigInt.asUintN(64, longs[li]) >> off;
    const spill = off + BigInt(bits) - 64n;
    if (spill > 0n) {
      v |= BigInt.asUintN(64, longs[li + 1]) << (BigInt(bits) - spill);
    }
    out[i] = Number(v & mask);
    bitPos += BigInt(bits);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseBlockState(compound) {
  const id = compound.Name.value;
  const props = {};
  if (compound.Properties) {
    for (const [key, child] of Object.entries(compound.Properties.value)) {
      props[key] = child.value;
    }
  }
  return { id, props };
}

function parseRegion(name, compound) {
  const pos = compound.Position.value;
  const size = compound.Size.value;
  const posX = pos.x.value;
  const posY = pos.y.value;
  const posZ = pos.z.value;
  const sizeXraw = size.x.value;
  const sizeYraw = size.y.value;
  const sizeZraw = size.z.value;

  // litemapy convention (tiles.py:107-109): region extents may be negative;
  // normalize to positive sizes with origin at the min corner.
  const minX = Math.min(posX, posX + sizeXraw + 1);
  const minY = Math.min(posY, posY + sizeYraw + 1);
  const minZ = Math.min(posZ, posZ + sizeZraw + 1);
  const sizeX = Math.abs(sizeXraw);
  const sizeY = Math.abs(sizeYraw);
  const sizeZ = Math.abs(sizeZraw);
  void minX;
  void minY;
  void minZ;

  const paletteList = compound.BlockStatePalette.value.items;
  const palette = paletteList.map((item) => parseBlockState(item.value));

  const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const longs = compound.BlockStates.value;
  const count = sizeX * sizeY * sizeZ;
  const indices = unpackBlockStates(longs, bits, count);

  const hasTileEntities =
    compound.TileEntities && compound.TileEntities.value.items.length > 0;

  const get = (x, y, z) => {
    const idx = indices[(y * sizeZ + z) * sizeX + x];
    return palette[idx];
  };

  return { name, sizeX, sizeY, sizeZ, get, hasTileEntities };
}

export function parseLitematic(uint8) {
  const { value: root } = readNbt(uint8);
  const rootValue = root.value;

  const metadata = rootValue.Metadata.value;
  const name = metadata.Name.value;
  const author = metadata.Author.value;
  const description = metadata.Description.value;

  const regionsCompound = rootValue.Regions.value;
  const warnings = [];
  const regions = Object.entries(regionsCompound).map(([regionName, regionTag]) => {
    const region = parseRegion(regionName, regionTag.value);
    if (region.hasTileEntities) {
      warnings.push(`Region "${regionName}" enthaelt TileEntities, die ignoriert werden.`);
    }
    const { hasTileEntities, ...publicRegion } = region;
    void hasTileEntities;
    return publicRegion;
  });

  return { name, author, description, regions, warnings };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function writeBlockState(state) {
  const compound = { Name: tag.string(state.id) };
  const propEntries = Object.entries(state.props);
  if (propEntries.length > 0) {
    const propsObj = {};
    for (const [key, value] of propEntries) {
      propsObj[key] = tag.string(String(value));
    }
    compound.Properties = tag.compound(propsObj);
  }
  return tag.compound(compound);
}

export function writeLitematic({
  name,
  author,
  description = "",
  sizeX,
  sizeY,
  sizeZ,
  palette,
  blocks,
  timestamp,
}) {
  if (!palette.length || stateKey(palette[0]) !== stateKey(AIR)) {
    throw new Error("palette[0] must be air");
  }

  const totalVolume = sizeX * sizeY * sizeZ;
  let totalBlocks = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] !== 0) totalBlocks++;
  }

  const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const longs = packBlockStates(blocks, bits);

  const ts = BigInt(timestamp);

  const metadata = tag.compound({
    EnclosingSize: tag.compound({
      x: tag.int(sizeX),
      y: tag.int(sizeY),
      z: tag.int(sizeZ),
    }),
    Author: tag.string(author),
    Description: tag.string(description),
    Name: tag.string(name),
    Software: tag.string("maze2schematic-web"),
    RegionCount: tag.int(1),
    TimeCreated: tag.long(ts),
    TimeModified: tag.long(ts),
    TotalBlocks: tag.int(totalBlocks),
    TotalVolume: tag.int(totalVolume),
    PreviewImageData: tag.intArray(new Int32Array(0)),
  });

  const blockStatePalette = tag.list(
    TAG.COMPOUND,
    palette.map((state) => writeBlockState(state)),
  );

  const region = tag.compound({
    Position: tag.compound({ x: tag.int(0), y: tag.int(0), z: tag.int(0) }),
    Size: tag.compound({ x: tag.int(sizeX), y: tag.int(sizeY), z: tag.int(sizeZ) }),
    BlockStatePalette: blockStatePalette,
    Entities: tag.list(TAG.COMPOUND, []),
    TileEntities: tag.list(TAG.COMPOUND, []),
    PendingBlockTicks: tag.list(TAG.COMPOUND, []),
    PendingFluidTicks: tag.list(TAG.COMPOUND, []),
    BlockStates: tag.longArray(longs),
  });

  const regions = tag.compound({ [name]: region });

  const root = tag.compound({
    Version: tag.int(6),
    SubVersion: tag.int(1),
    MinecraftDataVersion: tag.int(2975),
    Metadata: metadata,
    Regions: regions,
  });

  return writeNbt("", root);
}
