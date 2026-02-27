import React, { useState } from "react";
import { useWidget, McpUseProvider } from "mcp-use/react";

interface VerificationReportProps {
  checkType?: string;
  passed?: boolean;
  violationCount?: number;
  designName?: string;
  pdk?: string;
  matchCount?: string;
  details?: string;
}

const VerificationReport: React.FC = () => {
  const { props, isPending, theme } = useWidget<VerificationReportProps>();
  const [expanded, setExpanded] = useState(false);

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div style={{ padding: 20, fontFamily: "system-ui, sans-serif", color: "#888" }}>
          Running verification...
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
  const statusColor = props.passed ? passColor : failColor;

  return (
    <McpUseProvider autoSize>
      <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", color: textColor, background: bg }}>
        <div style={{ border: `1px solid ${border}`, borderRadius: 12, padding: 20, maxWidth: 520 }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                background: statusColor,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontSize: 20,
                fontWeight: "bold",
              }}
            >
              {props.passed ? "P" : "F"}
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                {props.checkType || "Verification"}: {props.passed ? "PASSED" : "FAILED"}
              </div>
              <div style={{ fontSize: 12, color: "#888" }}>
                {props.designName || "unknown"} / {props.pdk || "unknown"}
              </div>
            </div>
          </div>

          {/* Metrics */}
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ background: surface, padding: "10px 16px", borderRadius: 8, flex: 1, minWidth: 100 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", color: "#888", letterSpacing: 0.5 }}>
                Violations
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: statusColor, marginTop: 2 }}>
                {props.violationCount ?? "N/A"}
              </div>
            </div>
            {props.matchCount && (
              <div style={{ background: surface, padding: "10px 16px", borderRadius: 8, flex: 1, minWidth: 100 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", color: "#888", letterSpacing: 0.5 }}>
                  Circuits Matched
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: statusColor, marginTop: 2 }}>
                  {props.matchCount}
                </div>
              </div>
            )}
          </div>

          {/* Details toggle */}
          {props.details && (
            <div>
              <button
                onClick={() => setExpanded(!expanded)}
                style={{
                  background: surface,
                  border: `1px solid ${border}`,
                  borderRadius: 8,
                  padding: "8px 16px",
                  color: textColor,
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                  width: "100%",
                  textAlign: "left",
                }}
              >
                {expanded ? "Hide Details" : "Show Details"}
              </button>
              {expanded && (
                <pre
                  style={{
                    background: surface,
                    padding: 12,
                    borderRadius: "0 0 8px 8px",
                    fontSize: 11,
                    lineHeight: 1.5,
                    overflow: "auto",
                    maxHeight: 300,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    borderTop: `1px solid ${border}`,
                  }}
                >
                  {props.details}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </McpUseProvider>
  );
};

export default VerificationReport;
