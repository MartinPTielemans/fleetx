import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App, NoSession } from "./App";
import "./index.css";
import { startSession } from "./lib/api";
import { applyTheme, storedTheme } from "./lib/theme";

applyTheme(storedTheme());

const root = createRoot(document.getElementById("root")!);
// The app needs a token before its first request; getting one is quick.
void startSession().then((started) =>
  root.render(
    <StrictMode>
      {started.ok ? <App /> : <NoSession title={started.title} message={started.message} />}
    </StrictMode>,
  ),
);
