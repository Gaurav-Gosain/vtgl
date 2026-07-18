// GLSL ES 3.00 shader sources for the four instanced passes. Geometry is a unit
// quad expanded from gl_VertexID (drawArraysInstanced, TRIANGLE_STRIP, 4 verts),
// so there is no vertex buffer. The per-cell grid position is derived from
// gl_InstanceID and u_cols, keeping the big passes to one small instance record.
//
// Color packing: fg/bg/decoration colors are 24-bit 0xRRGGBB uints. Style bits:
// bit0 colored, bit1 faint, bit2 blink, bits 8..15 atlas page (texture array
// layer). See renderer/instances.ts StyleBit.

const QUAD = /* glsl */ `
  vec2 quadCorner() {
    return vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  }
`;

const UNPACK_RGB = /* glsl */ `
  vec3 unpackRgb(uint c) {
    return vec3(
      float((c >> 16u) & 255u),
      float((c >> 8u) & 255u),
      float(c & 255u)
    ) / 255.0;
  }
`;

const CLIP = /* glsl */ `
  vec4 toClip(vec2 px, vec2 res) {
    vec2 c = (px / res) * 2.0 - 1.0;
    return vec4(c.x, -c.y, 0.0, 1.0);
  }
`;

export const bgVert = `#version 300 es
precision highp float;
layout(location = 0) in uint a_bg;
uniform vec2 u_resolution;
uniform vec2 u_cellSize;
uniform int u_cols;
flat out vec4 v_color;
${QUAD}
${UNPACK_RGB}
${CLIP}
void main() {
  int col = gl_InstanceID % u_cols;
  int row = gl_InstanceID / u_cols;
  vec2 corner = quadCorner();
  vec2 px = (vec2(float(col), float(row)) + corner) * u_cellSize;
  gl_Position = toClip(px, u_resolution);
  v_color = vec4(unpackRgb(a_bg), 1.0);
}`;

export const bgFrag = `#version 300 es
precision highp float;
flat in vec4 v_color;
out vec4 o_color;
void main() { o_color = v_color; }`;

export const glyphVert = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_atlas;    // texels x, y, w, h
layout(location = 1) in vec2 a_glyphOff; // device-px offset within the cell
layout(location = 2) in uint a_fg;       // packed 0xRRGGBB
layout(location = 3) in uint a_style;
uniform vec2 u_resolution;
uniform vec2 u_cellSize;
uniform vec2 u_atlasSize;
uniform int u_cols;
out vec2 v_uv;
flat out vec3 v_fg;
flat out uint v_style;
${QUAD}
${UNPACK_RGB}
${CLIP}
void main() {
  int col = gl_InstanceID % u_cols;
  int row = gl_InstanceID / u_cols;
  vec2 corner = quadCorner();
  vec2 cellOrigin = vec2(float(col), float(row)) * u_cellSize;
  vec2 px = cellOrigin + a_glyphOff + corner * a_atlas.zw;
  gl_Position = toClip(px, u_resolution);
  v_uv = (a_atlas.xy + corner * a_atlas.zw) / u_atlasSize;
  v_fg = unpackRgb(a_fg);
  v_style = a_style;
}`;

export const glyphFrag = `#version 300 es
precision highp float;
uniform highp sampler2DArray u_atlas;
uniform float u_time;
in vec2 v_uv;
flat in vec3 v_fg;
flat in uint v_style;
out vec4 o_color;
void main() {
  int layer = int((v_style >> 8u) & 255u);
  vec4 t = texture(u_atlas, vec3(v_uv, float(layer)));
  bool colored = (v_style & 1u) != 0u;
  bool faint = (v_style & 2u) != 0u;
  bool blink = (v_style & 4u) != 0u;
  vec3 rgb = colored ? t.rgb : v_fg;
  float a = t.a;
  if (faint) a *= 0.5;
  if (blink) a *= step(0.5, fract(u_time));
  o_color = vec4(rgb, a);
}`;

// Cursor block-glyph variant: same fragment shader, but positioned by an
// explicit origin uniform instead of deriving the cell from gl_InstanceID.
export const glyphAtVert = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_atlas;
layout(location = 1) in vec2 a_glyphOff;
layout(location = 2) in uint a_fg;
layout(location = 3) in uint a_style;
uniform vec2 u_resolution;
uniform vec2 u_atlasSize;
uniform vec2 u_origin; // device-px top-left of the target cell
out vec2 v_uv;
flat out vec3 v_fg;
flat out uint v_style;
${QUAD}
${UNPACK_RGB}
${CLIP}
void main() {
  vec2 corner = quadCorner();
  vec2 px = u_origin + a_glyphOff + corner * a_atlas.zw;
  gl_Position = toClip(px, u_resolution);
  v_uv = (a_atlas.xy + corner * a_atlas.zw) / u_atlasSize;
  v_fg = unpackRgb(a_fg);
  v_style = a_style;
}`;

// Solid-rect program shared by decorations and the cursor rect.
export const solidVert = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_rect;  // device-px x, y, w, h
layout(location = 1) in uint a_color; // packed 0xRRGGBB
uniform vec2 u_resolution;
flat out vec4 v_color;
${QUAD}
${UNPACK_RGB}
${CLIP}
void main() {
  vec2 corner = quadCorner();
  vec2 px = a_rect.xy + corner * a_rect.zw;
  gl_Position = toClip(px, u_resolution);
  v_color = vec4(unpackRgb(a_color), 1.0);
}`;

export const solidFrag = `#version 300 es
precision highp float;
flat in vec4 v_color;
out vec4 o_color;
void main() { o_color = v_color; }`;
