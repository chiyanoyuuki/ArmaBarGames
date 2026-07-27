import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Home } from "./views/Home";
import { TvView } from "./views/TvView";
import { PlayView } from "./views/PlayView";
import { HostView } from "./views/HostView";
import { StatsView } from "./views/StatsView";
import "./styles.css";

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/tv", element: <TvView /> },
  { path: "/play", element: <PlayView /> },
  { path: "/host", element: <HostView /> },
  { path: "/stats", element: <StatsView /> },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
