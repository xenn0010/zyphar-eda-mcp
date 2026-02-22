import React, { useState } from "react";
import { useWidget, McpUseProvider } from "mcp-use/react";

interface ChipDesignProps {
  designName?: string;
  pdk?: string;
  cells?: string;
  area?: string;
  wns?: string;
  duration?: string;
  hasGds?: boolean;
  jobDir?: string;
  filename?: string;
}

const ChipDesignResult: React.FC = () => {
  const { props, isPending, theme, callTool, openExternal } = useWidget<ChipDesignProps>();
  const [downloading, setDownloading] = useState(false);

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div style={{ padding: 20, fontFamily: "system-ui, sans-serif", color: "#888" }}>
          Designing chip...
        </div>
      </McpUseProvider>
    );
  }

  const entries = [
    ["Cells", props.cells],
    ["Area", props.area],
    ["Timing (WNS)", props.wns],
    ["Runtime", props.duration],
  ].filter((e) => e[1]) as [string, string][];

  const isDark = theme === "dark";
  const bg = isDark ? "#1a1a2e" : "#ffffff";
  const textColor = isDark ? "#e0e0e0" : "#1a1a2e";
  const surface = isDark ? "#2a2a3e" : "#f5f5f5";
  const border = isDark ? "#3a3a4e" : "#e0e0e0";

  const handleDownload = async () => {
    if (!props.jobDir || downloading) return;
    setDownloading(true);
    try {
      const res = await callTool("download-gdsii", {
        job_dir: props.jobDir,
        filename: props.filename || "design",
      });
      const sc = res?.structuredContent as Record<string, string> | undefined;
      if (sc?.dataUrl) {
        openExternal(sc.dataUrl);
      }
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <McpUseProvider autoSize>
      <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", color: textColor, background: bg }}>
        <div
          style={{
            border: `1px solid ${border}`,
            borderRadius: 12,
            padding: 20,
            maxWidth: 480,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div
              style={{
                width: 36,
                height: 36,
                background: "#16213e",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#00d4ff",
                fontSize: 18,
                fontWeight: "bold",
              }}
            >
              IC
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{props.designName || "Chip Design"}</div>
              <div style={{ fontSize: 12, color: "#888" }}>{props.pdk || "Sky130 130nm"}</div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginBottom: 16,
            }}
          >
            {entries.map(([label, value]) => (
              <div key={label} style={{ background: surface, padding: "10px 12px", borderRadius: 8 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", color: "#888", letterSpacing: 0.5 }}>
                  {label}
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>{value}</div>
              </div>
            ))}
          </div>

          {props.hasGds ? (
            <button
              onClick={handleDownload}
              disabled={downloading}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                width: "100%",
                padding: 12,
                background: downloading ? "#2a3a5e" : "#16213e",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: downloading ? "wait" : "pointer",
                opacity: downloading ? 0.7 : 1,
              }}
            >
              {downloading ? (
                "Downloading..."
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download GDSII
                </>
              )}
            </button>
          ) : (
            <div style={{ textAlign: "center", padding: 8, color: "#888", fontSize: 13 }}>
              GDSII not generated. Use design-chip-signoff for downloadable layout.
            </div>
          )}
        </div>
      </div>
    </McpUseProvider>
  );
};

export default ChipDesignResult;
