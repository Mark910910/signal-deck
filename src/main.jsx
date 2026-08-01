import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import PortalPage from "./PortalPage.jsx";
import "./index.css";

// Deliberately no router dependency — one extra package is one more thing
// that can break for someone with no dev experience. A path check is all
// this needs: /portal/<slug> is the public, no-login customer page;
// everything else is the staff app behind Supabase Auth.
const path = window.location.pathname;
const portalMatch = path.match(/^\/portal\/(.+)$/);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {portalMatch ? <PortalPage slug={decodeURIComponent(portalMatch[1])} /> : <App />}
  </React.StrictMode>
);
