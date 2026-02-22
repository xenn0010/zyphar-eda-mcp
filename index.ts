import { MCPServer, text, image, mix, widget } from "mcp-use/server";
import { z } from "zod";
import { Client } from "ssh2";
import { readFileSync } from "fs";

const EC2_HOST = "ec2-18-219-59-121.us-east-2.compute.amazonaws.com";
const ZYPHAR_ENV = "export PATH=$HOME/.cargo/bin:$PATH && export ORFS_PATH=/tmp/OpenROAD-flow-scripts && cd ~/Zyphar-new";

function getSSHKey(): string {
  if (process.env.SSH_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString("utf-8");
  }
  if (process.env.SSH_PRIVATE_KEY) {
    return process.env.SSH_PRIVATE_KEY;
  }
  const keyPath = process.env.SSH_KEY_PATH || "/Users/yeabsirateshome/.ssh/Zyphar.pem";
  return readFileSync(keyPath, "utf-8");
}

function runOnEC2(cmd: string, timeoutMs = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = "";

    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    conn.on("ready", () => {
      conn.exec(`${ZYPHAR_ENV} && ${cmd}`, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          reject(err);
          return;
        }
        stream.on("data", (data: Buffer) => {
          output += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          output += data.toString();
        });
        stream.on("close", () => {
          clearTimeout(timer);
          conn.end();
          resolve(output);
        });
      });
    });

    conn.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`SSH connection failed: ${err.message}. Ensure SSH_PRIVATE_KEY env var is set.`));
    });

    conn.connect({
      host: EC2_HOST,
      port: 22,
      username: "ubuntu",
      privateKey: getSSHKey(),
      readyTimeout: 15000,
    });
  });
}

async function uploadFile(filename: string, content: string, dir?: string): Promise<string> {
  const jobId = Date.now().toString(36);
  const jobDir = dir || `/tmp/mcp_jobs/${jobId}`;
  await runOnEC2(`mkdir -p ${jobDir}`);
  // Quoted heredoc << 'EOF' preserves content literally -- no escaping needed
  await runOnEC2(`cat > ${jobDir}/${filename} << 'ZYPHAR_EOF_MARKER'\n${content}\nZYPHAR_EOF_MARKER`);
  return `${jobDir}/${filename}`;
}

function extractTopModule(verilog: string): string {
  const match = verilog.match(/module\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
  return match ? match[1] : "top";
}

function parseDesignStats(output: string): Record<string, string> {
  const stats: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (/^Cells:/.test(trimmed)) stats.cells = trimmed.replace("Cells:", "").trim();
    if (/^Area:/.test(trimmed)) stats.area = trimmed.replace("Area:", "").trim();
    if (/^WNS:/.test(trimmed)) stats.wns = trimmed.replace("WNS:", "").trim();
    if (/^Instances:/.test(trimmed)) stats.instances = trimmed.replace("Instances:", "").trim();
    if (/^Duration:/.test(trimmed)) stats.duration = trimmed.replace("Duration:", "").trim();
    if (/Flow completed/.test(trimmed)) stats.status = "completed";
  }
  return stats;
}

async function getGdsiiBase64(jobDir: string, top: string): Promise<string | null> {
  try {
    const b64 = await runOnEC2(
      `gds_file=$(find ${jobDir}/output -name "*.gds" 2>/dev/null | head -1) && [ -f "$gds_file" ] && base64 "$gds_file" | tr -d '\\n' || echo "NO_GDS"`,
      30000
    );
    if (b64.trim() === "NO_GDS" || b64.trim().length < 100) return null;
    return b64.trim();
  } catch {
    return null;
  }
}

async function extract3DLayout(jobDir: string): Promise<any | null> {
  try {
    const gdsFile = (await runOnEC2(
      `find ${jobDir}/output -name "*.gds" 2>/dev/null | head -1`
    )).trim();
    if (!gdsFile) return null;
    const jsonPath = `${jobDir}/output/layout_3d.json`;
    const result = await runOnEC2(
      `GDS_PATH=${gdsFile} OUT_PATH=${jsonPath} klayout -b -r /tmp/extract_3d.py 2>&1`,
      30000
    );
    if (!result.includes("OK")) return null;
    const json = await runOnEC2(`cat ${jsonPath}`);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function renderLayoutPng(jobDir: string): Promise<string | null> {
  try {
    const jsonPath = `${jobDir}/output/layout_3d.json`;
    const pngPath = `${jobDir}/output/layout.png`;
    const result = await runOnEC2(
      `JSON_PATH=${jsonPath} OUT_PATH=${pngPath} python3 /tmp/render_layout.py 2>&1`,
      15000
    );
    if (!result.includes("OK")) return null;
    const b64 = await runOnEC2(`base64 ${pngPath} | tr -d '\\n'`, 15000);
    if (b64.trim().length > 100) return b64.trim();
    return null;
  } catch {
    return null;
  }
}

const CHIP_3D_HTML = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; overflow: hidden; }
  #canvas { width: 100%; height: 100%; display: block; }
  #info { position: absolute; top: 8px; left: 8px; color: #ccc; font: 12px -apple-system, sans-serif; pointer-events: none; }
  #info span { background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 4px; }
  #legend { position: absolute; bottom: 8px; left: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .leg { font: 10px -apple-system, sans-serif; color: #ccc; display: flex; align-items: center; gap: 3px; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 3px; cursor: pointer; user-select: none; }
  .leg.off { opacity: 0.3; }
  .leg-dot { width: 8px; height: 8px; border-radius: 2px; }
  #loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); color: #888; font: 14px sans-serif; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="info"><span id="info-text">Drag to rotate, scroll to zoom</span></div>
<div id="legend" id="legend"></div>
<div id="loading">Loading 3D layout...</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x1a1a2e);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 10000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.1;

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(1, 2, 1);
scene.add(dirLight);

const layerGroups = {};

function buildScene(data) {
  document.getElementById('loading').style.display = 'none';
  const die = data.die;
  const cx = die.x + die.w / 2, cy = die.y + die.h / 2;
  const scale = 100 / Math.max(die.w, die.h);
  const zScale = scale * 150;

  // Substrate
  const subGeo = new THREE.BoxGeometry(die.w * scale, 0.5, die.h * scale);
  const subMat = new THREE.MeshPhongMaterial({ color: 0x2a2a3a });
  const sub = new THREE.Mesh(subGeo, subMat);
  sub.position.set(0, -0.3, 0);
  scene.add(sub);

  const legend = document.getElementById('legend');
  data.layers.forEach(function(layer) {
    var color = parseInt(layer.color.replace('#',''), 16);
    var mat = new THREE.MeshPhongMaterial({
      color: color,
      transparent: true,
      opacity: layer.opacity,
      side: THREE.DoubleSide,
    });
    var group = new THREE.Group();
    group.name = layer.name;
    layerGroups[layer.name] = group;

    layer.polygons.forEach(function(pts) {
      var shape = new THREE.Shape();
      for (var i = 0; i < pts.length; i++) {
        var x = (pts[i][0] - cx) * scale;
        var y = (pts[i][1] - cy) * scale;
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      }
      shape.closePath();
      var geo = new THREE.ExtrudeGeometry(shape, {
        depth: layer.thickness * zScale,
        bevelEnabled: false,
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = layer.z * zScale;
      group.add(mesh);
    });
    scene.add(group);

    var el = document.createElement('div');
    el.className = 'leg';
    el.innerHTML = '<div class="leg-dot" style="background:' + layer.color + '"></div>' + layer.name + ' (' + layer.polygons.length + ')';
    el.addEventListener('click', function() {
      group.visible = !group.visible;
      el.classList.toggle('off');
    });
    legend.appendChild(el);
  });

  var maxDim = Math.max(die.w, die.h) * scale;
  camera.position.set(maxDim * 0.8, maxDim * 0.6, maxDim * 0.8);
  controls.target.set(0, 2, 0);
  controls.update();

  var info = document.getElementById('info-text');
  info.textContent = die.w.toFixed(1) + ' x ' + die.h.toFixed(1) + ' um | ' +
    data.layers.reduce(function(s,l){ return s + l.polygons.length; }, 0) + ' polygons | ' +
    data.layers.length + ' layers';
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', function() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// MCP Apps bridge
if (window.parent !== window) {
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'ui/notifications/tool-result' && e.data.structuredContent) {
      if (e.data.structuredContent.layout3d) buildScene(e.data.structuredContent.layout3d);
    }
  });
  window.parent.postMessage({ type: 'ui/initialize', version: '1.0' }, '*');
}
// ChatGPT Apps SDK
if (window.openai && window.openai.toolOutput && window.openai.toolOutput.layout3d) buildScene(window.openai.toolOutput.layout3d);
window.addEventListener('openai:set_globals', function(e) {
  if (e.detail && e.detail.globals && e.detail.globals.toolOutput && e.detail.globals.toolOutput.layout3d)
    buildScene(e.detail.globals.toolOutput.layout3d);
});
// URL params fallback
try {
  var p = new URLSearchParams(window.location.search);
  if (p.get('mcpUseParams')) { var d = JSON.parse(decodeURIComponent(p.get('mcpUseParams'))); if (d.layout3d) buildScene(d.layout3d); }
} catch(e) {}
</script>
</body>
</html>`;

const CHIP_RESULT_HTML = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; background: var(--color-bg, #fff); color: var(--color-text, #1a1a2e); }
  .card { border: 1px solid var(--color-border, #e0e0e0); border-radius: 12px; padding: 20px; max-width: 480px; }
  .header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .chip-icon { width: 36px; height: 36px; background: #16213e; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #00d4ff; font-size: 18px; font-weight: bold; }
  .title { font-size: 18px; font-weight: 600; }
  .subtitle { font-size: 12px; color: #666; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .stat { background: var(--color-surface, #f5f5f5); padding: 10px 12px; border-radius: 8px; }
  .stat-label { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: 0.5px; }
  .stat-value { font-size: 16px; font-weight: 600; margin-top: 2px; }
  .download-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 12px; background: #16213e; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
  .download-btn:hover { background: #1a2744; }
  .download-btn:disabled { background: #999; cursor: not-allowed; }
  .download-btn svg { width: 18px; height: 18px; }
  .no-gds { text-align: center; padding: 8px; color: #888; font-size: 13px; }
</style>
</head>
<body>
<div class="card" id="root">
  <div class="header">
    <div class="chip-icon">IC</div>
    <div>
      <div class="title" id="design-name">Chip Design</div>
      <div class="subtitle" id="pdk-info">Sky130 130nm</div>
    </div>
  </div>
  <div class="stats" id="stats-grid"></div>
  <div id="download-area"></div>
</div>
<script>
function render(props) {
  if (!props) return;
  if (props.designName) document.getElementById('design-name').textContent = props.designName;
  if (props.pdk) document.getElementById('pdk-info').textContent = props.pdk;
  const grid = document.getElementById('stats-grid');
  grid.innerHTML = '';
  const entries = [
    ['Cells', props.cells],
    ['Area', props.area],
    ['Timing (WNS)', props.wns],
    ['Runtime', props.duration],
  ].filter(e => e[1]);
  entries.forEach(([label, value]) => {
    grid.innerHTML += '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + '</div></div>';
  });
  const dlArea = document.getElementById('download-area');
  if (props.gdsii_base64) {
    dlArea.innerHTML = '<button class="download-btn" id="dl-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download GDSII</button>';
    document.getElementById('dl-btn').addEventListener('click', function() {
      var raw = atob(props.gdsii_base64);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (props.filename || 'design') + '.gds';
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(url);
      a.remove();
    });
  } else {
    dlArea.innerHTML = '<div class="no-gds">GDSII not generated. Use design-chip-signoff for downloadable layout.</div>';
  }
}
// MCP Apps bridge (Claude, Cursor)
if (window.parent !== window) {
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'ui/notifications/tool-result' && e.data.structuredContent) {
      render(e.data.structuredContent);
    }
  });
  window.parent.postMessage({ type: 'ui/initialize', version: '1.0' }, '*');
}
// ChatGPT Apps SDK
if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
window.addEventListener('openai:set_globals', function(e) {
  if (e.detail && e.detail.globals && e.detail.globals.toolOutput) render(e.detail.globals.toolOutput);
});
// URL params fallback (dev inspector)
try {
  var p = new URLSearchParams(window.location.search);
  if (p.get('mcpUseParams')) render(JSON.parse(decodeURIComponent(p.get('mcpUseParams'))));
} catch(e) {}
</script>
</body>
</html>`;

const server = new MCPServer({
  name: "zyphar-eda",
  title: "Zyphar EDA - Chip Design from Chat",
  version: "1.0.0",
  description: "Design chips from chat. Full RTL-to-GDSII: synthesis, place & route, timing, DRC, LVS. Supports Sky130, GF180MCU, ASAP7 PDKs.",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
});

server.uiResource({
  type: "rawHtml",
  name: "chip-design-result",
  title: "Chip Design Result",
  description: "Interactive chip design results with GDSII download",
  htmlContent: CHIP_RESULT_HTML,
});

server.uiResource({
  type: "rawHtml",
  name: "chip-3d-viewer",
  title: "3D Chip Layout Viewer",
  description: "Interactive 3D visualization of chip layout layers using Three.js",
  htmlContent: CHIP_3D_HTML,
});

server.tool(
  {
    name: "design-chip",
    description: "Run the full RTL-to-GDSII chip design flow on Verilog source code. Runs synthesis (Yosys), place & route (OpenROAD), and generates a physical layout with downloadable GDSII file. Returns cell count, die area, timing (WNS), and an interactive results card with download button.",
    schema: z.object({
      verilog: z.string().describe("Complete Verilog source code for the design"),
      top_module: z.string().optional().describe("Top-level module name. Auto-detected from Verilog if omitted."),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130").describe("Process design kit: sky130 (130nm), gf180mcu (180nm), asap7 (7nm predictive)"),
      freq_mhz: z.number().default(100).describe("Target clock frequency in MHz"),
      clock_port: z.string().default("clk").describe("Name of the clock port in the design"),
    }),
    widget: {
      name: "chip-design-result",
      invoking: "Designing chip...",
      invoked: "Chip design complete",
    },
  },
  async ({ verilog, top_module, pdk, freq_mhz, clock_port }) => {
    const top = top_module || extractTopModule(verilog);
    const inputPath = await uploadFile("input.v", verilog);
    const jobDir = inputPath.replace("/input.v", "");
    const output = await runOnEC2(
      `./target/release/zyphar flow -i ${inputPath} --top ${top} --pdk ${pdk} --freq ${freq_mhz} --clock ${clock_port} --no-pdn --util 0.45 --gds --output ${jobDir}/output 2>&1`,
      600000
    );
    const stats = parseDesignStats(output);
    const gdsii_base64 = await getGdsiiBase64(jobDir, top);
    const pdkLabel: Record<string, string> = { sky130: "Sky130 130nm", gf180mcu: "GF180MCU 180nm", asap7: "ASAP7 7nm" };
    return widget({
      props: {
        designName: top,
        pdk: pdkLabel[pdk] || pdk,
        cells: stats.cells || stats.instances || "N/A",
        area: stats.area || "N/A",
        wns: stats.wns || "N/A",
        duration: stats.duration || "N/A",
        gdsii_base64: gdsii_base64,
        filename: top,
        jobDir: jobDir,
      },
      output: text(output),
    });
  }
);

server.tool(
  {
    name: "run-demo-design",
    description: "Run a pre-validated demo design through the full chip design flow. Available designs: picorv32 (RISC-V CPU, ~14K cells), uart_tx (UART transmitter, ~100 cells), alu_8bit (8-bit ALU, ~255 cells). All are DRC/LVS clean on Sky130.",
    schema: z.object({
      design: z.enum(["picorv32", "uart_tx", "alu_8bit"]).describe("Which demo design to run"),
      freq_mhz: z.number().default(100).describe("Target clock frequency in MHz"),
    }),
  },
  async ({ design, freq_mhz }) => {
    const paths: Record<string, [string, string]> = {
      picorv32: ["/tmp/OpenROAD-flow-scripts/flow/designs/src/picorv32/picorv32.v", "picorv32"],
      uart_tx: ["~/Zyphar-new/test_designs/uart_tx.v", "uart_tx"],
      alu_8bit: ["~/Zyphar-new/test_designs/alu_8bit.v", "alu_8bit"],
    };
    const [path, top] = paths[design];
    const output = await runOnEC2(
      `./target/release/zyphar flow -i ${path} --top ${top} --pdk sky130 --freq ${freq_mhz} --output /tmp/mcp_demo_${design}_${Date.now()} 2>&1`,
      600000
    );
    return text(output);
  }
);

server.tool(
  {
    name: "synthesize",
    description: "Synthesize Verilog source code to a gate-level netlist using Yosys. Returns cell count, area breakdown, and the synthesized netlist. Faster than full design-chip since it skips place & route.",
    schema: z.object({
      verilog: z.string().describe("Complete Verilog source code"),
      top_module: z.string().optional().describe("Top-level module name. Auto-detected from Verilog if omitted."),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130"),
    }),
  },
  async ({ verilog, top_module, pdk }) => {
    const top = top_module || extractTopModule(verilog);
    const inputPath = await uploadFile("input.v", verilog);
    const jobDir = inputPath.replace("/input.v", "");
    const output = await runOnEC2(
      `./target/release/zyphar flow -i ${inputPath} --top ${top} --pdk ${pdk} --skip-pnr --no-pdn --output ${jobDir}/output 2>&1`
    );
    return text(output);
  }
);

server.tool(
  {
    name: "estimate-ppa",
    description: "Quick power-performance-area estimate from cell count. No EDA tools needed -- returns instantly. Useful for early design exploration before running the full flow.",
    schema: z.object({
      cells: z.number().describe("Estimated number of standard cells"),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130"),
      freq_mhz: z.number().default(100).describe("Target clock frequency in MHz"),
    }),
  },
  async ({ cells, pdk, freq_mhz }) => {
    const params: Record<string, [number, number, number]> = {
      sky130: [2.0, 0.01, 0.1],
      gf180mcu: [1.6, 0.008, 0.085],
      asap7: [0.5, 0.003, 0.05],
    };
    const [cellArea, powerPerCell, gateDelay] = params[pdk] || params.sky130;
    const area = cells * cellArea;
    const levels = Math.max(1, Math.floor(Math.pow(cells, 0.3)));
    const critDelay = levels * gateDelay;
    const maxFreq = critDelay > 0 ? 1000 / critDelay : 1000;
    const power = cells * powerPerCell * (freq_mhz / 100);
    const feasible = (1000 / freq_mhz) > critDelay;
    return text(
      `PPA Estimate (${pdk}, ${cells} cells @ ${freq_mhz} MHz)\n` +
      `Area: ${Math.round(area)} um2\n` +
      `Power: ${power.toFixed(2)} mW\n` +
      `Max Frequency: ${Math.round(maxFreq)} MHz\n` +
      `Logic Levels: ${levels}\n` +
      `Timing Feasible: ${feasible ? "YES" : "NO -- reduce frequency or optimize design"}`
    );
  }
);

server.tool(
  {
    name: "design-chip-signoff",
    description: "Run full RTL-to-GDSII flow WITH signoff verification (DRC + LVS). Takes longer but produces manufacturing-ready output with DRC clean and LVS verified results. Returns an interactive card with downloadable GDSII file.",
    schema: z.object({
      verilog: z.string().describe("Complete Verilog source code for the design"),
      top_module: z.string().optional().describe("Top-level module name. Auto-detected from Verilog if omitted."),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130"),
      freq_mhz: z.number().default(100).describe("Target clock frequency in MHz"),
      clock_port: z.string().default("clk").describe("Name of the clock port"),
    }),
    widget: {
      name: "chip-design-result",
      invoking: "Designing chip with signoff...",
      invoked: "Chip design with signoff complete",
    },
  },
  async ({ verilog, top_module, pdk, freq_mhz, clock_port }) => {
    const top = top_module || extractTopModule(verilog);
    const inputPath = await uploadFile("input.v", verilog);
    const jobDir = inputPath.replace("/input.v", "");
    const output = await runOnEC2(
      `./target/release/zyphar flow -i ${inputPath} --top ${top} --pdk ${pdk} --freq ${freq_mhz} --clock ${clock_port} --no-pdn --util 0.45 --output ${jobDir}/output --signoff --gds --detailed-route 2>&1`,
      600000
    );
    const stats = parseDesignStats(output);
    const gdsii_base64 = await getGdsiiBase64(jobDir, top);
    const pdkLabel: Record<string, string> = { sky130: "Sky130 130nm", gf180mcu: "GF180MCU 180nm", asap7: "ASAP7 7nm" };
    return widget({
      props: {
        designName: top,
        pdk: pdkLabel[pdk] || pdk,
        cells: stats.cells || stats.instances || "N/A",
        area: stats.area || "N/A",
        wns: stats.wns || "N/A",
        duration: stats.duration || "N/A",
        gdsii_base64: gdsii_base64,
        filename: top,
      },
      output: text(output),
    });
  }
);

server.tool(
  {
    name: "view-chip-3d",
    description: "Render an interactive 3D visualization of a chip layout. Extracts real polygon data from the GDSII file using KLayout and displays it as a rotatable, zoomable 3D model with all physical layers (diffusion, poly, metal1-5, vias). Call this AFTER design-chip or design-chip-signoff to visualize the result.",
    schema: z.object({
      job_dir: z.string().describe("The job directory from a previous design-chip run (shown in the output path)"),
    }),
    widget: {
      name: "chip-3d-viewer",
      invoking: "Rendering 3D layout...",
      invoked: "3D layout ready",
    },
  },
  async ({ job_dir }) => {
    const layout3d = await extract3DLayout(job_dir);
    if (!layout3d) {
      return text("No GDSII file found. Run design-chip first.");
    }
    const totalPolys = layout3d.layers.reduce((s: number, l: any) => s + l.polygons.length, 0);
    const summary = `3D Layout: ${layout3d.die.w.toFixed(1)} x ${layout3d.die.h.toFixed(1)} um die, ${layout3d.layers.length} layers, ${totalPolys} polygons`;
    const pngB64 = await renderLayoutPng(job_dir);
    if (pngB64) {
      return widget({
        props: { layout3d },
        output: mix(image(pngB64, "image/png"), text(summary)),
      });
    }
    return widget({
      props: { layout3d },
      output: text(summary),
    });
  }
);

server.tool(
  {
    name: "simulate",
    description: "Simulate a Verilog design with a testbench using Icarus Verilog. Proves functional correctness -- does the design actually do what it should? Returns simulation output including $display/$monitor messages. The testbench should use $finish to end simulation.",
    schema: z.object({
      verilog: z.string().describe("Complete Verilog source code for the design under test"),
      testbench: z.string().describe("Verilog testbench that instantiates the design, drives inputs, and checks outputs using $display and $finish"),
    }),
  },
  async ({ verilog, testbench }) => {
    const jobId = Date.now().toString(36);
    const jobDir = `/tmp/mcp_sim/${jobId}`;
    await runOnEC2(`mkdir -p ${jobDir}`);
    await runOnEC2(`cat > ${jobDir}/design.v << 'ZYPHAR_EOF_MARKER'\n${verilog}\nZYPHAR_EOF_MARKER`);
    await runOnEC2(`cat > ${jobDir}/tb.v << 'ZYPHAR_EOF_MARKER'\n${testbench}\nZYPHAR_EOF_MARKER`);
    const output = await runOnEC2(
      `cd ${jobDir} && iverilog -o sim.vvp design.v tb.v 2>&1 && timeout 10 vvp sim.vvp 2>&1`,
      30000
    );
    return text(output);
  }
);

server.tool(
  {
    name: "fpga-synthesize",
    description: "Synthesize Verilog for FPGA using Yosys. Maps the design to FPGA primitives (LUTs, flip-flops, BRAMs) and reports resource utilization. Proves the design can run on real FPGA hardware. Supported targets: ice40 (Lattice iCE40), ecp5 (Lattice ECP5), xilinx (Xilinx 7-series).",
    schema: z.object({
      verilog: z.string().describe("Complete Verilog source code"),
      top_module: z.string().optional().describe("Top-level module name. Auto-detected if omitted."),
      fpga: z.enum(["ice40", "ecp5", "xilinx"]).default("ice40").describe("FPGA target: ice40 (Lattice iCE40 HX8K), ecp5 (Lattice ECP5), xilinx (Xilinx 7-series)"),
    }),
  },
  async ({ verilog, top_module, fpga }) => {
    const top = top_module || extractTopModule(verilog);
    const jobId = Date.now().toString(36);
    const jobDir = `/tmp/mcp_fpga/${jobId}`;
    await runOnEC2(`mkdir -p ${jobDir}`);
    await runOnEC2(`cat > ${jobDir}/design.v << 'ZYPHAR_EOF_MARKER'\n${verilog}\nZYPHAR_EOF_MARKER`);

    const fpgaCmd: Record<string, string> = {
      ice40: `synth_ice40 -top ${top} -json ${jobDir}/out.json`,
      ecp5: `synth_ecp5 -top ${top} -json ${jobDir}/out.json`,
      xilinx: `synth_xilinx -top ${top} -json ${jobDir}/out.json`,
    };

    const output = await runOnEC2(
      `yosys -p "read_verilog ${jobDir}/design.v; ${fpgaCmd[fpga]}; stat" 2>&1`,
      60000
    );
    // Extract just the stat summary (after "Printing statistics.")
    const statIdx = output.indexOf("Printing statistics.");
    const errorLines = output.split("\n").filter(l => /ERROR|error:/.test(l));
    if (errorLines.length > 0) {
      return text(`FPGA Synthesis FAILED (${fpga.toUpperCase()})\n${errorLines.join("\n")}`);
    }
    const stats = statIdx >= 0 ? output.slice(statIdx) : output.slice(-500);
    return text(`FPGA Synthesis Results (${fpga.toUpperCase()})\n${stats.trim()}`);
  }
);

server.prompt(
  {
    name: "design-a-chip",
    description: "Design a custom chip from a natural language description. Guides you through writing Verilog, running synthesis and place & route, and interpreting the results.",
    schema: z.object({
      description: z.string().optional().describe("What kind of chip to design, e.g. 'a UART transmitter' or 'an 8-bit CPU'"),
    }),
  },
  async ({ description }) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are a chip design assistant with access to Zyphar EDA tools that run real industry-grade synthesis (Yosys) and place & route (OpenROAD) on a cloud server.

WORKFLOW -- follow these steps in order:
1. Write complete, synthesizable Verilog for the user's request. Use Verilog-2005 (not SystemVerilog). Always include a clock port named "clk" for sequential designs.
2. Write a testbench that exercises the design with test vectors and uses $display to show results.
3. Call "simulate" with both the design and testbench. This proves functional correctness.
4. Call "fpga-synthesize" to show it maps to real FPGA hardware (LUTs, flip-flops).
5. Call "design-chip" to run full ASIC synthesis + place & route. This produces a physical chip layout.
6. Call "view-chip-3d" with the job directory from the design-chip output to show an interactive 3D visualization.
7. Present all results: simulation PASS/FAIL, FPGA resources, ASIC cell count, die area, timing, 3D layout.

VERILOG RULES:
- Use "always @(posedge clk)" for sequential logic, "always @(*)" for combinational
- Use "assign" for simple combinational outputs
- Register all outputs for better timing
- Keep designs under 1000 lines for fast turnaround (2-5 seconds)
- No SystemVerilog features (no "logic", no "always_ff", no interfaces)

TESTBENCH RULES:
- Instantiate the design under test
- Generate clock: always #5 clk = ~clk;
- Drive inputs and check outputs with $display
- Print PASS or FAIL based on expected vs actual values
- End with $finish

AVAILABLE TOOLS:
- simulate: Run Verilog simulation with testbench (iverilog). Proves the design WORKS. ~1 second.
- fpga-synthesize: Synthesize for FPGA (iCE40/ECP5/Xilinx). Proves it runs on FPGA hardware. ~2 seconds.
- design-chip: Full ASIC RTL-to-GDSII (Yosys + OpenROAD). Produces physical chip layout. ~2-15 seconds.
- synthesize: ASIC synthesis only (faster, no layout).
- estimate-ppa: Instant PPA estimate from cell count.
- run-demo-design: Run a known-good design (picorv32, uart_tx, alu_8bit).
- design-chip-signoff: Full flow + DRC + LVS verification for manufacturing readiness.
- view-chip-3d: Interactive 3D visualization of the chip layout. Call AFTER design-chip. Pass the job directory path.

The user wants to design: ${description || "a chip (ask them what kind)"}`,
          },
        },
      ],
    };
  }
);

server.prompt(
  {
    name: "demo",
    description: "Run a quick demo showing Zyphar designing a real chip in seconds. Perfect for showing the platform capabilities.",
    schema: z.object({}),
  },
  async () => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are demoing Zyphar EDA -- a platform that designs real chips from chat.

Run this demo sequence:
1. First, call "run-demo-design" with design "alu_8bit" to show a quick design (takes ~2 seconds).
2. Present the results: cell count, area, timing, runtime.
3. Then call "run-demo-design" with design "picorv32" to show a full RISC-V CPU being designed (takes ~15 seconds, 14K+ cells).
4. Present the results and compare: the platform just designed a complete RISC-V CPU with 14,000+ instances in under 20 seconds.
5. Explain that users can also write their own Verilog and have it synthesized and placed & routed in seconds using the "design-chip" tool.

Key talking points:
- This is REAL synthesis (Yosys) and place & route (OpenROAD), not simulation
- The output is a physical chip layout (DEF file) that could be sent to a foundry
- Supports 3 PDKs: Sky130 (130nm, Google/SkyWater), GF180MCU (180nm, GlobalFoundries), ASAP7 (7nm predictive)
- Designs from 10 cells to 50,000+ cells in seconds to minutes`,
          },
        },
      ],
    };
  }
);

server.listen().then(() => {
  console.log("Zyphar EDA MCP server running");
});
