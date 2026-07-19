import { useAuth } from "@clerk/clerk-react";
import { useMemo } from "react";
import { createApiClient } from "./api";

export function useApi() {
  const { getToken } = useAuth();
  return useMemo(() => createApiClient(getToken), [getToken]);
}
