import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
  // 仅开发期加载：生产构建里这段会被整体剔除（不会产出 bench chunk）
  void import("./bench").then((mod) => mod.startBenchIfEnabled());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
