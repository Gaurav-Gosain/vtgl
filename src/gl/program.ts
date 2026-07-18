// Minimal WebGL2 program/shader helpers. No dependencies, no globals; every
// resource is owned by the caller (the WebGL2 renderer) so context loss and
// dispose can tear everything down deterministically.

export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('vtgl: createShader failed');
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    throw new Error('vtgl: shader compile failed: ' + log);
  }
  return sh;
}

export function linkProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('vtgl: createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  // Shaders can be detached/deleted once linked.
  gl.detachShader(prog, vs);
  gl.detachShader(prog, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '';
    gl.deleteProgram(prog);
    throw new Error('vtgl: program link failed: ' + log);
  }
  return prog;
}

/** Fetch and cache all named uniform locations for a program. */
export function uniformLocations(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  names: readonly string[],
): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}
