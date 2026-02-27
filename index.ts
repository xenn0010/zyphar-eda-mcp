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

function runOnEC2(cmd: string, timeoutMs = 1800000): Promise<string> {
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
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const jobDir = dir || `/tmp/mcp_jobs/${jobId}`;
  await runOnEC2(`mkdir -p ${jobDir}`);
  const filePath = `${jobDir}/${filename}`;

  // Use SFTP for reliable file transfer (heredoc fails on large files)
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error("SFTP upload timed out after 30s"));
    }, 30000);

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          reject(err);
          return;
        }
        sftp.writeFile(filePath, content, (err) => {
          clearTimeout(timer);
          conn.end();
          if (err) reject(err);
          else resolve(filePath);
        });
      });
    });

    conn.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`SFTP connection failed: ${err.message}`));
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

function extractTopModule(verilog: string): string {
  const match = verilog.match(/module\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
  return match ? match[1] : "top";
}

async function startBackgroundJob(
  jobDir: string,
  cmd: string,
  meta: Record<string, string> = {}
): Promise<{ jobId: string; jobDir: string }> {
  const jobId = jobDir.split("/").pop() || "unknown";
  // Write metadata (design name, pdk, freq, start time)
  const metaJson = JSON.stringify({ ...meta, startTime: Date.now(), status: "running" });
  await runOnEC2(`mkdir -p ${jobDir}/output && echo '${metaJson}' > ${jobDir}/meta.json`, 15000);
  // Launch the actual command in background with nohup
  // The shell writes exit code to exit_code file when done
  const bgCmd = `nohup bash -c '${ZYPHAR_ENV} && ${cmd} > ${jobDir}/output.log 2>&1; echo $? > ${jobDir}/exit_code' > /dev/null 2>&1 & echo $!`;
  const pid = (await runOnEC2(bgCmd, 15000)).trim();
  await runOnEC2(`echo '${pid}' > ${jobDir}/pid`, 10000);
  return { jobId, jobDir };
}

interface JobStatus {
  state: "running" | "completed" | "failed";
  elapsedSeconds: number;
  output?: string;
  stats?: Record<string, string>;
  hasGds?: boolean;
  meta?: Record<string, string>;
}

async function checkJobStatus(jobDir: string): Promise<JobStatus> {
  // Read metadata for start time
  let startTime = Date.now();
  try {
    const metaRaw = await runOnEC2(`cat ${jobDir}/meta.json 2>/dev/null || echo '{}'`, 10000);
    const meta = JSON.parse(metaRaw.trim());
    if (meta.startTime) startTime = meta.startTime;
  } catch { /* use current time as fallback */ }

  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

  // Check if exit_code file exists (means job finished)
  const exitCheck = (await runOnEC2(
    `[ -f ${jobDir}/exit_code ] && echo "DONE:$(cat ${jobDir}/exit_code)" || echo "RUNNING"`,
    10000
  )).trim();

  if (exitCheck === "RUNNING") {
    // Check if process is still alive
    let processAlive = false;
    try {
      const pidRaw = (await runOnEC2(`cat ${jobDir}/pid 2>/dev/null || echo ""`, 10000)).trim();
      if (pidRaw) {
        const psCheck = (await runOnEC2(`kill -0 ${pidRaw} 2>/dev/null && echo "ALIVE" || echo "DEAD"`, 10000)).trim();
        processAlive = psCheck === "ALIVE";
      }
    } catch { /* ignore */ }

    if (!processAlive) {
      // Process died without writing exit_code -- check if log exists
      try {
        const tailLog = await runOnEC2(`tail -20 ${jobDir}/output.log 2>/dev/null || echo "No log file"`, 10000);
        return { state: "failed", elapsedSeconds, output: `Process died unexpectedly.\nLast log lines:\n${tailLog.trim()}` };
      } catch {
        return { state: "failed", elapsedSeconds, output: "Process died unexpectedly. No log available." };
      }
    }
    return { state: "running", elapsedSeconds };
  }

  // Job finished -- parse exit code
  const exitCode = exitCheck.replace("DONE:", "").trim();
  const output = await runOnEC2(`cat ${jobDir}/output.log 2>/dev/null || echo ""`, 30000);

  if (exitCode !== "0") {
    const lastLines = output.split("\n").slice(-30).join("\n");
    return { state: "failed", elapsedSeconds, output: `Exit code ${exitCode}.\n${lastLines}` };
  }

  // Success -- parse stats and check for GDS
  const stats = parseDesignStats(output);
  const hasGds = await runOnEC2(
    `find ${jobDir}/output -name "*.gds" 2>/dev/null | head -1`
  ).then(r => r.trim().length > 0).catch(() => false);

  return { state: "completed", elapsedSeconds, output, stats, hasGds };
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

const server = new MCPServer({
  name: "zyphar-eda",
  title: "Zyphar EDA - Chip Design from Chat",
  version: "1.0.0",
  description: "Design chips from chat. Full RTL-to-GDSII: synthesis, place & route, timing, DRC, LVS. Supports Sky130, GF180MCU, ASAP7 PDKs.",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
});

server.tool(
  {
    name: "design-chip",
    description: "Start the full RTL-to-GDSII chip design flow on Verilog source code. Launches synthesis (Yosys) + place & route (OpenROAD) as a background job and returns immediately with a job directory. Use get-job-status to poll for results.",
    schema: z.object({
      verilog: z.string().describe("Complete Verilog source code for the design"),
      top_module: z.string().optional().describe("Top-level module name. Auto-detected from Verilog if omitted."),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130").describe("Process design kit: sky130 (130nm), gf180mcu (180nm), asap7 (7nm predictive)"),
      freq_mhz: z.number().default(100).describe("Target clock frequency in MHz"),
      clock_port: z.string().default("clk").describe("Name of the clock port in the design"),
    }),
  },
  async ({ verilog, top_module, pdk, freq_mhz, clock_port }) => {
    const top = top_module || extractTopModule(verilog);
    const inputPath = await uploadFile("input.v", verilog);
    const jobDir = inputPath.replace("/input.v", "");
    const flowCmd = `./target/release/zyphar flow -i ${inputPath} --top ${top} --pdk ${pdk} --freq ${freq_mhz} --clock ${clock_port} --no-pdn --util 0.45 --gds --output ${jobDir}/output`;
    const { jobDir: jd } = await startBackgroundJob(jobDir, flowCmd, {
      designName: top, pdk, freq: String(freq_mhz), tool: "design-chip",
    });
    return text(
      `Job started. Design: ${top}, PDK: ${pdk}, Freq: ${freq_mhz} MHz\n` +
      `Job directory: ${jd}\n\n` +
      `Use get-job-status with job_dir="${jd}" to check progress and get results.`
    );
  }
);

server.tool(
  {
    name: "run-demo-design",
    description: "Start a pre-validated demo design as a background job. Available designs: picorv32 (RISC-V CPU, ~14K cells), uart_tx (UART transmitter, ~100 cells), alu_8bit (8-bit ALU, ~255 cells). Returns immediately with a job directory. Use get-job-status to poll for results.",
    schema: z.object({
      design: z.enum(["picorv32", "uart_tx", "alu_8bit"]).describe("Which demo design to run"),
      freq_mhz: z.number().default(100).describe("Target clock frequency in MHz"),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130").describe("Process design kit"),
    }),
  },
  async ({ design, freq_mhz, pdk }) => {
    const paths: Record<string, [string, string]> = {
      picorv32: ["/tmp/OpenROAD-flow-scripts/flow/designs/src/picorv32/picorv32.v", "picorv32"],
      uart_tx: ["~/Zyphar-new/test_designs/uart_tx.v", "uart_tx"],
      alu_8bit: ["~/Zyphar-new/test_designs/alu_8bit.v", "alu_8bit"],
    };
    const [path, top] = paths[design];
    const jobDir = `/tmp/mcp_demo_${design}_${Date.now()}`;
    const flowCmd = `./target/release/zyphar flow -i ${path} --top ${top} --pdk ${pdk} --freq ${freq_mhz} --gds --output ${jobDir}/output`;
    const { jobDir: jd } = await startBackgroundJob(jobDir, flowCmd, {
      designName: `${top} (demo)`, pdk, freq: String(freq_mhz), tool: "run-demo-design",
    });
    return text(
      `Demo job started. Design: ${top}, PDK: ${pdk}, Freq: ${freq_mhz} MHz\n` +
      `Job directory: ${jd}\n\n` +
      `Use get-job-status with job_dir="${jd}" to check progress and get results.`
    );
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
    description: "Start full RTL-to-GDSII flow WITH signoff verification (DRC + LVS) as a background job. Returns immediately with a job directory. Use get-job-status to poll for results.",
    schema: z.object({
      verilog: z.string().describe("Complete Verilog source code for the design"),
      top_module: z.string().optional().describe("Top-level module name. Auto-detected from Verilog if omitted."),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130"),
      freq_mhz: z.number().default(100).describe("Target clock frequency in MHz"),
      clock_port: z.string().default("clk").describe("Name of the clock port"),
    }),
  },
  async ({ verilog, top_module, pdk, freq_mhz, clock_port }) => {
    const top = top_module || extractTopModule(verilog);
    const inputPath = await uploadFile("input.v", verilog);
    const jobDir = inputPath.replace("/input.v", "");
    const flowCmd = `./target/release/zyphar flow -i ${inputPath} --top ${top} --pdk ${pdk} --freq ${freq_mhz} --clock ${clock_port} --no-pdn --util 0.45 --output ${jobDir}/output --signoff --gds --detailed-route`;
    const { jobDir: jd } = await startBackgroundJob(jobDir, flowCmd, {
      designName: top, pdk, freq: String(freq_mhz), tool: "design-chip-signoff",
    });
    return text(
      `Signoff job started. Design: ${top}, PDK: ${pdk}, Freq: ${freq_mhz} MHz\n` +
      `Job directory: ${jd}\n\n` +
      `Use get-job-status with job_dir="${jd}" to check progress and get results.`
    );
  }
);

server.tool(
  {
    name: "get-job-status",
    description: "Check the status of a running chip design job. Returns results when complete, elapsed time when still running, or error details if failed. Use this after design-chip, design-chip-signoff, or run-demo-design to poll for completion.",
    schema: z.object({
      job_dir: z.string().describe("The job directory returned by design-chip, design-chip-signoff, or run-demo-design"),
    }),
    widget: {
      name: "chip-design-result",
      invoking: "Checking job status...",
      invoked: "Job status retrieved",
    },
  },
  async ({ job_dir }) => {
    const status = await checkJobStatus(job_dir);

    if (status.state === "running") {
      return text(
        `Job is still running. Elapsed: ${status.elapsedSeconds}s\n` +
        `Job directory: ${job_dir}\n\n` +
        `Call get-job-status again to check progress.`
      );
    }

    if (status.state === "failed") {
      return text(`Job FAILED after ${status.elapsedSeconds}s.\n\n${status.output || "No output available."}`);
    }

    // Completed -- read metadata for display
    let designName = "unknown";
    let pdkStr = "unknown";
    try {
      const metaRaw = await runOnEC2(`cat ${job_dir}/meta.json 2>/dev/null || echo '{}'`, 10000);
      const meta = JSON.parse(metaRaw.trim());
      designName = meta.designName || "unknown";
      pdkStr = meta.pdk || "unknown";
    } catch { /* ignore */ }

    const pdkLabel: Record<string, string> = { sky130: "Sky130 130nm", gf180mcu: "GF180MCU 180nm", asap7: "ASAP7 7nm" };
    const stats = status.stats || {};

    return widget({
      props: {
        designName,
        pdk: pdkLabel[pdkStr] || pdkStr,
        cells: stats.cells || stats.instances || "N/A",
        area: stats.area || "N/A",
        wns: stats.wns || "N/A",
        duration: stats.duration || `${status.elapsedSeconds}s`,
        hasGds: status.hasGds || false,
        jobDir: job_dir,
        filename: designName.replace(/ \(demo\)$/, ""),
      },
      output: text(status.output || "Completed"),
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
      name: "chip-layout",
      invoking: "Rendering chip layout...",
      invoked: "Chip layout rendered",
    },
  },
  async ({ job_dir }) => {
    const layout3d = await extract3DLayout(job_dir);
    if (!layout3d) {
      return text("No GDSII file found. Run design-chip first.");
    }
    const totalPolys = layout3d.layers.reduce((s: number, l: any) => s + l.polygons.length, 0);
    const summary = `Chip Layout: ${layout3d.die.w.toFixed(1)} x ${layout3d.die.h.toFixed(1)} um die, ${layout3d.layers.length} layers, ${totalPolys} polygons`;
    const pngB64 = await renderLayoutPng(job_dir);
    if (pngB64) {
      return widget({
        props: {
          image_base64: pngB64,
          die_w: layout3d.die.w,
          die_h: layout3d.die.h,
          layers: layout3d.layers.length,
          polygons: totalPolys,
        },
        output: text(summary),
      });
    }
    return text(summary + "\n(Image rendering failed -- PIL may not be installed on EC2)");
  }
);

server.tool(
  {
    name: "download-gdsii",
    description: "Download the GDSII layout file from a completed chip design job. Returns the file as a base64-encoded data URL that can be saved. Called by the chip-design-result widget when the user clicks Download.",
    schema: z.object({
      job_dir: z.string().describe("The job directory from a previous design-chip run"),
      filename: z.string().default("design").describe("Base filename for the downloaded .gds file"),
    }),
  },
  async ({ job_dir, filename }) => {
    const b64 = await getGdsiiBase64(job_dir, filename);
    if (!b64) {
      return text("No GDSII file found in " + job_dir);
    }
    return {
      content: [{ type: "text" as const, text: `GDSII file ready: ${filename}.gds` }],
      structuredContent: {
        dataUrl: `data:application/octet-stream;base64,${b64}`,
        filename: `${filename}.gds`,
      },
    };
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
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const jobDir = `/tmp/mcp_sim/${jobId}`;
    await runOnEC2(`mkdir -p ${jobDir}`);
    await uploadFile("design.v", verilog, jobDir);
    await uploadFile("tb.v", testbench, jobDir);
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
    await uploadFile("design.v", verilog, jobDir);

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
- design-chip: Start ASIC RTL-to-GDSII (Yosys + OpenROAD) as background job. Returns job_dir immediately.
- get-job-status: Poll a background job for completion. Returns results widget when done, elapsed time when running.
- synthesize: ASIC synthesis only (faster, no layout).
- estimate-ppa: Instant PPA estimate from cell count.
- run-demo-design: Start a known-good design (picorv32, uart_tx, alu_8bit) as background job.
- design-chip-signoff: Start full flow + DRC + LVS as background job.
- view-chip-3d: Interactive 3D visualization of the chip layout. Call AFTER get-job-status shows completion.

ASYNC WORKFLOW for design-chip, run-demo-design, design-chip-signoff:
1. Call the tool -- it returns instantly with a job_dir
2. Wait ~5 seconds, then call get-job-status with that job_dir
3. If still running, wait longer and poll again
4. When complete, get-job-status returns the full results widget with cell count, area, timing, and GDS download

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
