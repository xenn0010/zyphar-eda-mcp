import { MCPServer, text } from "mcp-use/server";
import { z } from "zod";
import { execSync } from "child_process";

const EC2_HOST = "ubuntu@ec2-18-219-59-121.us-east-2.compute.amazonaws.com";
const SSH_KEY = process.env.SSH_KEY_PATH || "/Users/yeabsirateshome/.ssh/Zyphar.pem";
const ZYPHAR_CMD = "cd ~/Zyphar-new && export PATH=$HOME/.cargo/bin:$PATH && export ORFS_PATH=/tmp/OpenROAD-flow-scripts";

function runOnEC2(cmd: string, timeoutMs = 300000): string {
  const sshCmd = `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${EC2_HOST} '${ZYPHAR_CMD} && ${cmd}'`;
  const result = execSync(sshCmd, {
    timeout: timeoutMs,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return result;
}

const server = new MCPServer({
  name: "zyphar-eda",
  title: "Zyphar EDA",
  version: "1.0.0",
  description: "Design chips from chat. RTL to GDSII: synthesis, place & route, DRC, LVS.",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
});

server.tool(
  {
    name: "design-chip",
    description: "Run full RTL-to-GDSII flow on Verilog source. Returns cells, area, timing, DRC status.",
    schema: z.object({
      verilog: z.string().describe("Verilog source code"),
      top_module: z.string().describe("Top module name"),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130"),
      freq_mhz: z.number().default(100),
      clock_port: z.string().default("clk"),
    }),
  },
  async ({ verilog, top_module, pdk, freq_mhz, clock_port }) => {
    const escaped = verilog.replace(/'/g, "'\\''");
    runOnEC2(`mkdir -p /tmp/mcp_job && cat > /tmp/mcp_job/input.v << 'VEOF'\n${escaped}\nVEOF`);
    const output = runOnEC2(
      `./target/release/zyphar flow -i /tmp/mcp_job/input.v --top ${top_module} --pdk ${pdk} --freq ${freq_mhz} --clock ${clock_port} --output-dir /tmp/mcp_job/output 2>&1`
    );
    return text(output);
  }
);

server.tool(
  {
    name: "run-demo-design",
    description: "Run a pre-validated demo: picorv32 (RISC-V, 14K cells), uart_tx (100 cells), alu_8bit (255 cells). DRC/LVS clean.",
    schema: z.object({
      design: z.enum(["picorv32", "uart_tx", "alu_8bit"]),
      freq_mhz: z.number().default(100),
    }),
  },
  async ({ design, freq_mhz }) => {
    const paths: Record<string, [string, string]> = {
      picorv32: ["/tmp/OpenROAD-flow-scripts/flow/designs/src/picorv32/picorv32.v", "picorv32"],
      uart_tx: ["~/Zyphar-new/test_designs/uart_tx.v", "uart_tx"],
      alu_8bit: ["~/Zyphar-new/test_designs/alu_8bit.v", "alu_8bit"],
    };
    const [path, top] = paths[design];
    const output = runOnEC2(
      `./target/release/zyphar flow -i ${path} --top ${top} --pdk sky130 --freq ${freq_mhz} --output-dir /tmp/mcp_demo_${design} 2>&1`
    );
    return text(output);
  }
);

server.tool(
  {
    name: "synthesize",
    description: "Synthesize Verilog to gate-level netlist using Yosys. Returns cell count, area, netlist path.",
    schema: z.object({
      verilog: z.string().describe("Verilog source code"),
      top_module: z.string(),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130"),
    }),
  },
  async ({ verilog, top_module, pdk }) => {
    const escaped = verilog.replace(/'/g, "'\\''");
    runOnEC2(`mkdir -p /tmp/mcp_synth && cat > /tmp/mcp_synth/input.v << 'VEOF'\n${escaped}\nVEOF`);
    const output = runOnEC2(
      `./target/release/zyphar flow -i /tmp/mcp_synth/input.v --top ${top_module} --pdk ${pdk} --synth-only --output-dir /tmp/mcp_synth/output 2>&1`
    );
    return text(output);
  }
);

server.tool(
  {
    name: "estimate-ppa",
    description: "Quick PPA estimate from cell count. No EDA tools needed.",
    schema: z.object({
      cells: z.number().describe("Number of standard cells"),
      pdk: z.enum(["sky130", "gf180mcu", "asap7"]).default("sky130"),
      freq_mhz: z.number().default(100),
    }),
  },
  async ({ cells, pdk, freq_mhz }) => {
    const p: Record<string, [number, number, number]> = {
      sky130: [2.0, 0.01, 0.1],
      gf180mcu: [1.6, 0.008, 0.085],
      asap7: [0.5, 0.003, 0.05],
    };
    const [ca, pp, gd] = p[pdk] || p.sky130;
    const area = cells * ca;
    const levels = Math.max(1, Math.floor(Math.pow(cells, 0.3)));
    const delay = levels * gd;
    const maxFreq = delay > 0 ? 1000 / delay : 1000;
    const power = cells * pp * (freq_mhz / 100);
    return text(
      `PPA Estimate (${pdk}, ${cells} cells @ ${freq_mhz} MHz)\n` +
      `Area: ${Math.round(area)} um2\n` +
      `Power: ${(power).toFixed(2)} mW\n` +
      `Max Freq: ${Math.round(maxFreq)} MHz\n` +
      `Logic Levels: ${levels}\n` +
      `Feasible: ${(1000 / freq_mhz) > delay ? "YES" : "NO"}`
    );
  }
);

server.tool(
  {
    name: "run-drc",
    description: "Run design rule check on a GDS file via KLayout.",
    schema: z.object({
      gds_path: z.string().describe("Path to GDS file on EC2"),
      top_cell: z.string(),
    }),
  },
  async ({ gds_path, top_cell }) => {
    const output = runOnEC2(
      `./target/release/zyphar flow --drc-only --gds ${gds_path} --top ${top_cell} --pdk sky130 2>&1`
    );
    return text(output);
  }
);

server.tool(
  {
    name: "run-lvs",
    description: "Run layout vs schematic verification.",
    schema: z.object({
      gds_path: z.string().describe("Path to GDS file on EC2"),
      netlist_path: z.string().describe("Path to netlist on EC2"),
      top_cell: z.string(),
    }),
  },
  async ({ gds_path, netlist_path, top_cell }) => {
    const output = runOnEC2(
      `./target/release/zyphar flow --lvs-only --gds ${gds_path} --netlist ${netlist_path} --top ${top_cell} --pdk sky130 2>&1`
    );
    return text(output);
  }
);

server.listen().then(() => {
  console.log("Zyphar EDA MCP server running");
});
