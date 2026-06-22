import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { SessionProvider } from "../session/SessionProvider";
import { queryClient } from "../data/queryClient";
import { ActiveSpaceProvider } from "./ActiveSpace";
import { ThemeProvider } from "./ThemeProvider";
import { AppRoutes } from "./routes";

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SessionProvider>
            <ActiveSpaceProvider>
              <AppRoutes />
            </ActiveSpaceProvider>
          </SessionProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
