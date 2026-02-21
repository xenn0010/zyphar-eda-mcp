import { MCPServer, text } from "mcp-use/server";
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

async function uploadFile(filename: string, content: string): Promise<string> {
  const jobId = Date.now().toString(36);
  const jobDir = `/tmp/mcp_jobs/${jobId}`;
  await runOnEC2(`mkdir -p ${jobDir}`);
  const escaped = content.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
  await runOnEC2(`cat > ${jobDir}/${filename} << 'ZYPHAR_VERILOG_EOF'\n${escaped}\nZYPHAR_VERILOG_EOF`);
  return `${jobDir}/${filename}`;
}

function extractTopModule(verilog: string): string {
  const match = verilog.match(/module\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
  return match ? match[1] : "top";
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
    description: "Run the full RTL-to-GDSII chip design flow on Verilog source code. Runs synthesis (Yosys), place & route (OpenROAD), and generates a physical layout. Returns cell count, die area, timing (WNS), and DRC violations.",
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
    const output = await runOnEC2(
      `./target/release/zyphar flow -i ${inputPath} --top ${top} --pdk ${pdk} --freq ${freq_mhz} --clock ${clock_port} --no-pdn --util 0.45 --output ${jobDir}/output 2>&1`,
      600000
    );
    return text(output);
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
    description: "Run full RTL-to-GDSII flow WITH signoff verification (DRC + LVS). Takes longer but produces manufacturing-ready output with DRC clean and LVS verified results.",
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
    const output = await runOnEC2(
      `./target/release/zyphar flow -i ${inputPath} --top ${top} --pdk ${pdk} --freq ${freq_mhz} --clock ${clock_port} --no-pdn --util 0.45 --output ${jobDir}/output --signoff --gds --detailed-route 2>&1`,
      600000
    );
    return text(output);
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

WORKFLOW:
1. Write complete, synthesizable Verilog for the user's request. Use Verilog-2005 (not SystemVerilog). Always include a clock port named "clk" for sequential designs.
2. Call the "design-chip" tool with the Verilog source. The top module name is auto-detected. Default PDK is sky130 (130nm), default frequency is 100 MHz.
3. Present the results clearly: cell count, die area (um2), timing slack (WNS), number of instances, and total runtime.
4. If the user wants changes, modify the Verilog and re-run.

VERILOG RULES:
- Use "always @(posedge clk)" for sequential logic, "always @(*)" for combinational
- Use "assign" for simple combinational outputs
- Register all outputs for better timing
- Keep designs under 1000 lines for fast turnaround (2-5 seconds)
- No SystemVerilog features (no "logic", no "always_ff", no interfaces)

AVAILABLE TOOLS:
- design-chip: Full RTL-to-GDSII (synthesis + place & route). Takes 2-15 seconds depending on size.
- synthesize: Synthesis only (faster, no layout). Good for checking cell count first.
- estimate-ppa: Instant PPA estimate from cell count. No tools needed.
- run-demo-design: Run a known-good design (picorv32, uart_tx, alu_8bit) to demonstrate the flow.
- design-chip-signoff: Full flow + DRC + LVS verification. Takes longer but proves manufacturing readiness.

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
