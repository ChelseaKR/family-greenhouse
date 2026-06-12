import { useQuery } from '@tanstack/react-query';
import { taskService } from '@/services/taskService';

/**
 * Active + upcoming vacation windows for the household. One query shared by
 * every member row (same key → a single fetch). Lives outside the component
 * file so react-refresh sees MemberVacation.tsx as components-only.
 */
export function useVacationWindows(householdId: string | null) {
  return useQuery({
    queryKey: ['tasks', householdId, 'vacations'],
    queryFn: () => taskService.getVacationWindows(),
    enabled: !!householdId,
  });
}
