import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { SessionProvider } from "../session/SessionProvider";
import { queryClient } from "../data/queryClient";
import { ActiveSpaceProvider } from "./ActiveSpace";
import { ThemeProvider } from "./ThemeProvider";
import { Toasts } from "../ui/toast";
import { BrandingApplier } from "./BrandingApplier";
import { AppRoutes } from "./routes";

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SessionProvider>
            <ActiveSpaceProvider>
              <BrandingApplier />
              <AppRoutes />
              <Toasts />
            </ActiveSpaceProvider>
          </SessionProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
