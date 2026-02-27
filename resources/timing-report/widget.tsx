import React from "react";
import { useWidget, McpUseProvider } from "mcp-use/react";

interface TimingReportProps {
  wns?: string;
  tns?: string;
  freqMhz?: number;
  clockPort?: string;
  timingMet?: boolean;
  criticalPath?: string;
  pdk?: string;
}

const TimingReport: React.FC = () => {
  const { props, isPending, theme } = useWidget<TimingReportProps>();

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div style={{ padding: 20, fontFamily: "system-ui, sans-serif", color: "#888" }}>
          Analyzing timing...
        </div>
      </McpUseProvider>
    );
  }

  const isDark = theme === "dark";
  const bg = isDark ? "#1a1a2e" : "#ffffff";
  const textColor = isDark ? "#e0e0e0" : "#1a1a2e";
  const surface = isDark ? "#2a2a3e" : "#f5f5f5";
  const border = isDark ? "#3a3a4e" : "#e0e0e0";
  const passColor = "#22c55e";
  const failColor = "#ef4444";
  const statusColor = props.timingMet ? passColor : failColor;

  const entries = [
    ["WNS", props.wns ? `${props.wns} ns` : "N/A"],
    ["TNS", props.tns ? `${props.tns} ns` : "N/A"],
    ["Frequency", props.freqMhz ? `${props.freqMhz} MHz` : "N/A"],
    ["Clock", props.clockPort || "N/A"],
  ];

  return (
    <McpUseProvider autoSize>
      <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", color: textColor, background: bg }}>
        <div style={{ border: `1px solid ${border}`, borderRadius: 12, padding: 20, maxWidth: 520 }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div
              style={{
                width: 36,
                height: 36,
                background: statusColor,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontSize: 14,
                fontWeight: "bold",
              }}
            >
              {props.timingMet ? "OK" : "!!"}
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                Timing {props.timingMet ? "MET" : "VIOLATED"}
              </div>
              <div style={{ fontSize: 12, color: "#888" }}>
                {props.pdk || "unknown"} PDK
              </div>
            </div>
          </div>

          {/* Metrics grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            {entries.map(([label, value]) => (
              <div key={label} style={{ background: surface, padding: "10px 12px", borderRadius: 8 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", color: "#888", letterSpacing: 0.5 }}>
                  {label}
                </div>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    marginTop: 2,
                    color: label === "WNS" ? statusColor : textColor,
                  }}
                >
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Critical path */}
          {props.criticalPath && (
            <div>
              <div style={{ fontSize: 12, textTransform: "uppercase", color: "#888", marginBottom: 6 }}>
                Critical Path
              </div>
              <pre
                style={{
                  background: surface,
                  padding: 12,
                  borderRadius: 8,
                  fontSize: 11,
                  lineHeight: 1.5,
                  overflow: "auto",
                  maxHeight: 200,
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {props.criticalPath}
              </pre>
            </div>
          )}
        </div>
      </div>
    </McpUseProvider>
  );
};

export default TimingReport;
