import { useEffect, useState } from "react";
import { useListSchedule, useCreateScheduleEntry, useUpdateScheduleEntry, useDeleteScheduleEntry, getListScheduleQueryKey, useListAdminVideos, useListPlaylists } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Plus, Loader2, Clock, Trash2, AlertTriangle, Radio } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// ── Local-time helpers ──────────────────────────────────────────────────────
// Schedule times are stored as HH:MM in UTC. The viewer's browser may be in a
// different timezone, so we render a small inline hint next to each UTC time
// showing the equivalent local time. We deliberately do NOT shift entries to
// different day columns: that would change the meaning of "today" and risks
// confusing operators reading a 7-day grid.
function utcHmToLocal(hm: string) {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date();
  d.setUTCHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

function fmtLocalTime(d: Date) {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function localTzAbbr() {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" });
    const parts = fmt.formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

function LocalTimeHint({ startUtc, endUtc }: { startUtc: string; endUtc?: string }) {
  // If the viewer is already in UTC there's nothing to add.
  if (new Date().getTimezoneOffset() === 0) return null;
  const start = fmtLocalTime(utcHmToLocal(startUtc));
  const end = endUtc ? fmtLocalTime(utcHmToLocal(endUtc)) : null;
  const tz = localTzAbbr();
  return (
    <span className="text-[10px] text-muted-foreground/80">
      · {start}
      {end ? `–${end}` : ""} {tz}
    </span>
  );
}

function slotsOverlap(a: { startTime: string; endTime?: string | null }, b: { startTime: string; endTime?: string | null }) {
  const aStart = timeToMinutes(a.startTime);
  const aEnd = a.endTime ? timeToMinutes(a.endTime) : aStart + 60;
  const bStart = timeToMinutes(b.startTime);
  const bEnd = b.endTime ? timeToMinutes(b.endTime) : bStart + 60;
  return aStart < bEnd && bStart < aEnd;
}

export default function Schedule() {
  const { data: schedule, isLoading, isError, error: scheduleError, refetch: refetchSchedule } = useListSchedule();
  const { data: videos } = useListAdminVideos({ limit: 100 });
  const { data: playlists } = useListPlaylists();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const createEntry = useCreateScheduleEntry();
  const deleteEntry = useDeleteScheduleEntry();
  const updateEntry = useUpdateScheduleEntry();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Now-playing tracker (UTC because backend stores times in UTC HH:MM) ──
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const currentDayUtc = now.getUTCDay();
  const currentMinUtc = now.getUTCHours() * 60 + now.getUTCMinutes();

  const [formData, setFormData] = useState({
    title: "", dayOfWeek: 0, startTime: "09:00", endTime: "10:30", contentType: "live" as "live" | "playlist" | "video", contentId: "", isRecurring: true, isActive: true
  });

  // Hard conflict guard: when creating an entry that overlaps existing slots
  // on the same day, intercept the submit and ask the operator to confirm.
  const [pendingConflicts, setPendingConflicts] = useState<{ id: string; title: string; startTime: string; endTime: string | null }[] | null>(null);

  const resetContentType = (contentType: string) => {
    setFormData({ ...formData, contentType: contentType as "live" | "playlist" | "video", contentId: "" });
  };

  const submitCreate = () => {
    createEntry.mutate({ data: formData }, {
      onSuccess: () => {
        toast({ title: "Schedule entry created" });
        setIsCreateOpen(false);
        setPendingConflicts(null);
        queryClient.invalidateQueries({ queryKey: getListScheduleQueryKey() });
      },
      onError: () => toast({ title: "Failed to create schedule entry", variant: "destructive" })
    });
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.contentType !== "live" && !formData.contentId) {
      toast({ title: `Choose a ${formData.contentType} for this schedule slot`, variant: "destructive" });
      return;
    }
    // Detect overlaps against existing same-day entries.
    const conflicts = (Array.isArray(schedule) ? schedule : [])
      .filter((e) => e.dayOfWeek === formData.dayOfWeek && e.isActive !== false)
      .filter((e) =>
        slotsOverlap(
          { startTime: formData.startTime, endTime: formData.endTime || null },
          { startTime: e.startTime, endTime: e.endTime ?? null },
        ),
      )
      .map((e) => ({ id: e.id, title: e.title, startTime: e.startTime, endTime: e.endTime ?? null }));

    if (conflicts.length > 0) {
      setPendingConflicts(conflicts);
      return;
    }
    submitCreate();
  };

  const doDelete = (id: string) => {
    setDeleteId(null);
    deleteEntry.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Entry deleted" });
        queryClient.invalidateQueries({ queryKey: getListScheduleQueryKey() });
      },
      onError: () => toast({ title: "Failed to delete entry", variant: "destructive" })
    });
  };

  const handleToggle = (id: string, isActive: boolean) => {
    updateEntry.mutate({ id, data: { isActive } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListScheduleQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to update schedule entry", variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: getListScheduleQueryKey() });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Schedule</h1>
          <p className="text-muted-foreground mt-1">Manage weekly broadcasting and live streams.</p>
        </div>
        
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Schedule Slot</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Schedule Entry</DialogTitle></DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Day of Week</Label>
                  <Select value={formData.dayOfWeek.toString()} onValueChange={v => setFormData({...formData, dayOfWeek: parseInt(v)})}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DAYS.map((day, i) => <SelectItem key={i} value={i.toString()}>{day}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Content Type</Label>
                  <Select value={formData.contentType} onValueChange={resetContentType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="live">Live Service</SelectItem>
                      <SelectItem value="playlist">Playlist</SelectItem>
                      <SelectItem value="video">Single Video</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Start Time</Label>
                  <Input type="time" value={formData.startTime} onChange={e => setFormData({...formData, startTime: e.target.value})} required />
                </div>
                <div className="space-y-2">
                  <Label>End Time</Label>
                  <Input type="time" value={formData.endTime} onChange={e => setFormData({...formData, endTime: e.target.value})} />
                </div>
              </div>
              {formData.contentType !== "live" && (
                <div className="space-y-2">
                  <Label>{formData.contentType === "playlist" ? "Playlist" : "Video"}</Label>
                  <Select value={formData.contentId} onValueChange={v => setFormData({...formData, contentId: v})}>
                    <SelectTrigger>
                      <SelectValue placeholder={`Choose a ${formData.contentType}`} />
                    </SelectTrigger>
                    <SelectContent>
                      {formData.contentType === "playlist"
                        ? (Array.isArray(playlists) ? playlists : []).map((playlist) => (
                            <SelectItem key={playlist.id} value={playlist.id}>{playlist.name}</SelectItem>
                          ))
                        : (Array.isArray(videos?.videos) ? videos.videos : []).map((video: { id: string; title: string }) => (
                            <SelectItem key={video.id} value={video.id}>{video.title}</SelectItem>
                          ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex items-center justify-between pt-2">
                <Label>Active</Label>
                <Switch checked={formData.isActive} onCheckedChange={c => setFormData({...formData, isActive: c})} />
              </div>
              <Button type="submit" className="w-full" disabled={createEntry.isPending}>
                {createEntry.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Save"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <AlertDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Schedule Entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This schedule slot will be permanently removed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && doDelete(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingConflicts !== null} onOpenChange={(open) => { if (!open) setPendingConflicts(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Schedule conflict detected
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Your new <strong>{formData.startTime}{formData.endTime ? `–${formData.endTime}` : ""}</strong> slot on
                  {" "}<strong>{DAYS[formData.dayOfWeek]}</strong> overlaps {pendingConflicts?.length} existing entr
                  {pendingConflicts && pendingConflicts.length === 1 ? "y" : "ies"}:
                </p>
                <ul className="text-sm space-y-1.5 rounded-md border bg-muted/40 p-3">
                  {pendingConflicts?.map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs">
                        {c.startTime}{c.endTime ? `–${c.endTime}` : ""}
                      </span>
                      <span className="truncate">{c.title}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs">
                  Saving will create a stacked slot. Two simultaneous broadcasts may collide on the schedule grid.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel — fix the time</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-600/90"
              onClick={() => submitCreate()}
            >
              Save anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Failed to load schedule</p>
            <p className="text-xs text-muted-foreground mt-0.5 break-words">
              {scheduleError instanceof Error ? scheduleError.message : "The schedule API did not respond. Try again."}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetchSchedule()}>
            Retry
          </Button>
        </div>
      )}

      <TooltipProvider>
        <div className="grid gap-6 lg:grid-cols-7">
          {DAYS.map((day, dayIndex) => {
            // Defensive: schedule may be undefined while loading or a non-array
            // if the API contract drifts. Coerce to array so .filter/.sort never crash.
            const safeSchedule = Array.isArray(schedule) ? schedule : [];
            const dayEntries = safeSchedule
              .filter(e => e.dayOfWeek === dayIndex)
              .sort((a, b) => a.startTime.localeCompare(b.startTime));

            const entriesWithOverlap = new Set<string>();
            for (let i = 0; i < dayEntries.length; i++) {
              for (let j = i + 1; j < dayEntries.length; j++) {
                if (slotsOverlap(dayEntries[i], dayEntries[j])) {
                  entriesWithOverlap.add(dayEntries[i].id);
                  entriesWithOverlap.add(dayEntries[j].id);
                }
              }
            }

            const isToday = dayIndex === currentDayUtc;
            const nowMin = currentMinUtc;

            // Find which entry (if any) is on-air right now on this day
            let onAirId: string | null = null;
            if (isToday) {
              for (const e of dayEntries) {
                if (!e.isActive) continue;
                const start = timeToMinutes(e.startTime);
                const end = e.endTime ? timeToMinutes(e.endTime) : start + 60;
                if (nowMin >= start && nowMin < end) { onAirId = e.id; break; }
              }
            }

            // Where to insert the "now" marker among sorted day entries
            let nowMarkerAt = -1;
            if (isToday) {
              nowMarkerAt = dayEntries.findIndex(e => timeToMinutes(e.startTime) > nowMin);
              if (nowMarkerAt === -1) nowMarkerAt = dayEntries.length;
            }

            return (
              <div key={day} className={`flex flex-col gap-3 ${isToday ? "rounded-lg p-2 -m-2 bg-primary/5 ring-1 ring-primary/15" : ""}`}>
                <div className={`font-semibold text-sm pb-2 border-b flex items-center justify-between ${isToday ? "text-primary" : ""}`}>
                  <span>{day}</span>
                  {isToday && (
                    <span className="text-[10px] font-mono uppercase tracking-wider bg-primary/15 text-primary px-1.5 py-0.5 rounded">
                      Today · {String(now.getUTCHours()).padStart(2, "0")}:{String(now.getUTCMinutes()).padStart(2, "0")} UTC
                    </span>
                  )}
                </div>
                {isLoading ? (
                  <Skeleton className="h-24 w-full rounded-lg" />
                ) : dayEntries.length === 0 ? (
                  <>
                    {isToday && (
                      <div className="flex items-center gap-2 text-[10px] text-primary font-medium">
                        <span className="h-px flex-1 bg-primary/50" />
                        <span>NOW</span>
                        <span className="h-px flex-1 bg-primary/50" />
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-lg bg-muted/10">No events</div>
                  </>
                ) : (
                  <>
                    {dayEntries.map((entry, idx) => {
                      const hasOverlap = entriesWithOverlap.has(entry.id);
                      const isOnAir = entry.id === onAirId;
                      return (
                        <div key={entry.id}>
                          {isToday && nowMarkerAt === idx && (
                            <div className="flex items-center gap-2 text-[10px] text-primary font-medium mb-2">
                              <span className="h-px flex-1 bg-primary/50" />
                              <span>NOW</span>
                              <span className="h-px flex-1 bg-primary/50" />
                            </div>
                          )}
                          <div className={`p-3 rounded-lg border text-sm relative group transition-colors ${
                            isOnAir
                              ? 'bg-red-500/5 border-red-500/50 ring-1 ring-red-500/20'
                              : hasOverlap
                                ? 'bg-amber-500/5 border-amber-500/40'
                                : entry.isActive
                                  ? 'bg-card border-border hover:border-primary/50'
                                  : 'bg-muted/50 border-transparent opacity-60'
                          }`}>
                            {isOnAir && (
                              <span className="absolute -top-2 left-2 inline-flex items-center gap-1 bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider">
                                <Radio className="w-2.5 h-2.5 animate-pulse" /> On Air Now
                              </span>
                            )}
                            {hasOverlap && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertTriangle className="w-3 h-3 text-amber-500 absolute top-2 left-2" />
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <p className="text-xs">Time overlap with another slot on this day</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                            <div className="flex items-start justify-between mb-1">
                              <div className={`font-medium truncate pr-4 ${hasOverlap ? "pl-4" : ""} ${isOnAir ? "text-red-600 dark:text-red-400" : ""}`}>{entry.title}</div>
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 top-2 bg-background/80 p-1 rounded-md backdrop-blur-sm">
                                <Switch checked={entry.isActive} onCheckedChange={c => handleToggle(entry.id, c)} className="scale-75" />
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:bg-destructive/10" onClick={() => setDeleteId(entry.id)}>
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2 flex-wrap">
                              <Clock className="w-3 h-3 shrink-0" />
                              <span>{entry.startTime}{entry.endTime ? ` – ${entry.endTime}` : ""} UTC</span>
                              <LocalTimeHint
                                startUtc={entry.startTime}
                                endUtc={entry.endTime ?? undefined}
                              />
                            </div>
                            <div className="mt-2 inline-flex text-[10px] font-medium px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground uppercase tracking-wider">
                              {entry.contentType}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {isToday && nowMarkerAt === dayEntries.length && (
                      <div className="flex items-center gap-2 text-[10px] text-primary font-medium">
                        <span className="h-px flex-1 bg-primary/50" />
                        <span>NOW</span>
                        <span className="h-px flex-1 bg-primary/50" />
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </TooltipProvider>

      <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-4 flex-wrap">
        <Clock className="w-3.5 h-3.5" />
        <span>
          All times are stored in server timezone (UTC){" "}
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-1">UTC</Badge>
          {new Date().getTimezoneOffset() !== 0 && (
            <span className="ml-2 opacity-80">
              — local equivalent shown next to each slot ({localTzAbbr()})
            </span>
          )}
        </span>
        {Array.isArray(schedule) && schedule.some((_, i, arr) => {
          const entry = arr[i];
          return arr.some((other, j) => j !== i && other.dayOfWeek === entry.dayOfWeek && slotsOverlap(entry, other));
        }) && (
          <span className="flex items-center gap-1 ml-2 text-amber-600">
            <AlertTriangle className="w-3.5 h-3.5" />
            Some time slots overlap — review highlighted entries.
          </span>
        )}
      </div>
    </div>
  );
}
