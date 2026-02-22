import React from "react";
import { useWidget, McpUseProvider } from "mcp-use/react";

interface ChipLayoutProps {
  image_base64?: string;
  die_w?: number;
  die_h?: number;
  layers?: number;
  polygons?: number;
}

const ChipLayout: React.FC = () => {
  const { props, isPending, theme } = useWidget<ChipLayoutProps>();

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div style={{ padding: 20, fontFamily: "system-ui, sans-serif", color: "#888" }}>
          Rendering chip layout...
        </div>
      </McpUseProvider>
    );
  }

  const isDark = theme === "dark";
  const bg = isDark ? "#1a1a2e" : "#ffffff";
  const text = isDark ? "#e0e0e0" : "#1a1a2e";
  const surface = isDark ? "#2a2a3e" : "#f5f5f5";

  return (
    <McpUseProvider autoSize>
      <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", color: text, background: bg }}>
        {props.image_base64 ? (
          <div>
            <img
              src={`data:image/png;base64,${props.image_base64}`}
              alt="Chip Layout"
              style={{ width: "100%", maxWidth: 600, borderRadius: 8, display: "block" }}
            />
            <div
              style={{
                display: "flex",
                gap: 12,
                marginTop: 8,
                fontSize: 12,
                color: "#888",
                flexWrap: "wrap",
              }}
            >
              {props.die_w && props.die_h && (
                <span style={{ background: surface, padding: "4px 8px", borderRadius: 4 }}>
                  {props.die_w.toFixed(1)} x {props.die_h.toFixed(1)} um
                </span>
              )}
              {props.layers && (
                <span style={{ background: surface, padding: "4px 8px", borderRadius: 4 }}>
                  {props.layers} layers
                </span>
              )}
              {props.polygons && (
                <span style={{ background: surface, padding: "4px 8px", borderRadius: 4 }}>
                  {props.polygons} polygons
                </span>
              )}
            </div>
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
            No layout image available.
          </div>
        )}
      </div>
    </McpUseProvider>
  );
};

export default ChipLayout;
