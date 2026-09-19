import * as React from "react";
import { createRoot } from "react-dom/client";
import { RendererApp } from "@/features/app/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing");
document.documentElement.classList.add("dark", "h-full", "antialiased");
createRoot(root).render(<React.StrictMode><TooltipProvider><Toaster><RendererApp /></Toaster></TooltipProvider></React.StrictMode>);
