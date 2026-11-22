import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import { ApiError } from "./lib/api";
import { I18nProvider } from "./i18n/I18n";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // Spec §3.14: refetch on focus; the 60 s interval is set per group query in P4.
    queries: {
      refetchOnWindowFocus: true,
      // A 4xx won't change on retry; a network blip or 5xx might.
      retry: (failures, error) =>
        failures < 1 && !(error instanceof ApiError && error.status < 500),
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
