import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import PortalPage from "./PortalPage.jsx";
import AckPage from "./AckPage.jsx";
import TrackPage from "./TrackPage.jsx";
import "./index.css";

// Deliberately no router dependency — one extra package is one more thing
// that can break for someone with no dev experience. A path check is all
// this needs: /portal/<slug> is the public customer intake page, /ack/<token>
// is the public one-click acknowledge link, /join/<code> is a staff invite
// link, /track/<token> is a customer's own status + reply page, everything
// else is the staff app behind Supabase Auth.
const path = window.location.pathname;
const portalMatch = path.match(/^\/portal\/(.+)$/);
const ackMatch = path.match(/^\/ack\/(.+)$/);
const joinMatch = path.match(/^\/join\/(.+)$/);
const trackMatch = path.match(/^\/track\/(.+)$/);

function Router() {
  if (portalMatch) return <PortalPage slug={decodeURIComponent(portalMatch[1])} />;
  if (ackMatch) return <AckPage token={decodeURIComponent(ackMatch[1])} />;
  if (trackMatch) return <TrackPage token={decodeURIComponent(trackMatch[1])} />;
  return <App inviteCode={joinMatch ? decodeURIComponent(joinMatch[1]) : null} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>
);
