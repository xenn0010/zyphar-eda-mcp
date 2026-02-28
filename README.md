# Zyphar EDA MCP

Design chips from ChatGPT/Claude -- RTL to GDSII in seconds.

An MCP (Model Context Protocol) server that brings full chip design capabilities to AI assistants. Write Verilog, synthesize, place and route, and generate production-ready GDSII layouts through natural conversation.

## Features

- RTL-to-GDSII flow (synthesis + place and route)
- Multi-PDK support: Sky130, GF180MCU, ASAP7, IHP130
- FPGA synthesis (iCE40, ECP5, Xilinx 7-series)
- Verilog simulation with testbench support
- Static timing analysis
- DRC and LVS signoff verification
- Power analysis
- Design space exploration (frequency/PDK sweeps)
- SRAM macro generation
- Caravel SoC wrapper for tapeout

## Quick Start

```bash
npm install
npm run build
npm start
```

## Usage with Claude Desktop

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "zyphar-eda": {
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

Then ask Claude to design a chip:

> "Design an 8-bit ALU on Sky130 at 100MHz"

## Supported PDKs

| PDK | Node | Description |
|-----|------|-------------|
| sky130 | 130nm | SkyWater open-source PDK |
| gf180mcu | 180nm | GlobalFoundries open-source PDK |
| asap7 | 7nm | Predictive academic PDK |
| ihp130 | 130nm | IHP SG13G2 BiCMOS PDK |

## License

MIT
