import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  CalendarDays, Plus, Pencil, Trash2, Clock, Radio, Tv, Video, Link2,
  Zap, CalendarClock, RotateCcw,
} from "lucide-react";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CONTENT_TYPES = [
  { value: "live",     label: "Live Broadcast",  icon: Radio },
  { value: "video",    label: "Sermon Video",     icon: Video },
  { value: "playlist", label: "Playlist",         icon: Tv },
  { value: "external", label: "External Stream",  icon: Link2 },
] as const;

type ContentType = "live" | "video" | "playlist" | "external";

interface ScheduleEntry {
  id: string;
  title: string;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string | null;
  contentType: string;
  contentId: string | null;
  isRecurring: boolean;
  isActive: boolean;
  createdAt: string;
  scheduledDate: string | null;
  priorityOverride: boolean;
}

interface ListResponse { items: ScheduleEntry[]; total: number }

const BLANK_FORM = {
  title: "",
  isOneTime: false,
  dayOfWeek: 1,
  scheduledDate: "",
  startTime: "09:00",
  endTime: "",
  contentType: "live" as ContentType,
  contentId: "",
  priorityOverride: false,
  isRecurring: true,
  isActive: true,
};

function contentTypeIcon(ct: string) {
  const found = CONTENT_TYPES.find((c) => c.value === ct);
  const Icon = found?.icon ?? Tv;
  return <Icon size={13} className="shrink-0" />;
}

function statusBadge(isActive: boolean) {
  return isActive
    ? "bg-green-500/15 text-green-700 border-green-500/30"
    : "bg-muted text-muted-foreground";
}

function formatScheduledDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["schedule"] });
  void qc.invalidateQueries({ queryKey: ["schedule-upcoming"] });
  void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
  void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
  void qc.invalidateQueries({ queryKey: ["admin-stats"] });
  void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
  void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
  void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
  void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
}

export default function SchedulePage() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen]   = useState(false);
  const [editEntry, setEditEntry] = useState<ScheduleEntry | null>(null);
  const [deleteId, setDeleteId]  = useState<string | null>(null);
  const [form, setForm] = useState(BLANK_FORM);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["schedule"],
    queryFn:  () => api.get<ListResponse>("/schedule"),
    staleTime: 30_000,
  });

  const { data: upcomingData } = useQuery({
    queryKey: ["schedule-upcoming"],
    queryFn:  () => api.get<ListResponse>("/schedule/upcoming"),
    staleTime: 60_000,
  });

  useSSEEvent("broadcast-schedule-updated", () => {
    void qc.invalidateQueries({ queryKey: ["schedule"] });
    void qc.invalidateQueries({ queryKey: ["schedule-upcoming"] });
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof BLANK_FORM) => {
      const payload: Record<string, unknown> = {
        title:          body.title,
        startTime:      body.startTime,
        endTime:        body.endTime.trim() || null,
        contentType:    body.contentType,
        contentId:      body.contentId.trim() || null,
        priorityOverride: body.priorityOverride,
        isActive:       body.isActive,
      };
      if (body.isOneTime) {
        payload.scheduledDate = body.scheduledDate;
        payload.isRecurring = false;
      } else {
        payload.dayOfWeek = body.dayOfWeek;
        payload.isRecurring = body.isRecurring;
      }
      return api.post<ScheduleEntry>("/schedule", payload);
    },
    onSuccess: () => {
      toast.success("Schedule entry created");
      invalidateAll(qc);
      setAddOpen(false);
      setForm(BLANK_FORM);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to create entry"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: typeof BLANK_FORM }) => {
      const payload: Record<string, unknown> = {
        title:          patch.title,
        startTime:      patch.startTime,
        endTime:        patch.endTime.trim() || null,
        contentType:    patch.contentType,
        contentId:      patch.contentId.trim() || null,
        priorityOverride: patch.priorityOverride,
        isActive:       patch.isActive,
      };
      if (patch.isOneTime) {
        payload.scheduledDate = patch.scheduledDate;
        payload.isRecurring = false;
      } else {
        payload.dayOfWeek = patch.dayOfWeek;
        payload.scheduledDate = null;
        payload.isRecurring = patch.isRecurring;
      }
      return api.patch<ScheduleEntry>(`/schedule/${id}`, payload);
    },
    onSuccess: () => {
      toast.success("Schedule entry updated");
      invalidateAll(qc);
      setEditEntry(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update entry"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/schedule/${id}`),
    onSuccess: () => {
      toast.success("Removed from schedule");
      invalidateAll(qc);
      setDeleteId(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to delete"),
  });

  const items = data?.items ?? [];
  const recurring = useMemo(() => items.filter((e) => !e.scheduledDate), [items]);
  const oneTimeAll = useMemo(() => items.filter((e) => e.scheduledDate), [items]);
  const upcoming = upcomingData?.items ?? oneTimeAll.filter((e) => e.isActive);

  const byDay = useMemo(() => {
    const map: Record<number, ScheduleEntry[]> = {};
    for (let d = 0; d < 7; d++) map[d] = [];
    for (const e of recurring) {
      const dow = e.dayOfWeek ?? 0;
      map[dow]?.push(e);
    }
    for (let d = 0; d < 7; d++) map[d]?.sort((a, b) => a.startTime.localeCompare(b.startTime));
    return map;
  }, [recurring]);

  function openEdit(entry: ScheduleEntry) {
    setEditEntry(entry);
    setForm({
      title:           entry.title,
      isOneTime:       !!entry.scheduledDate,
      dayOfWeek:       entry.dayOfWeek ?? 1,
      scheduledDate:   entry.scheduledDate ?? "",
      startTime:       entry.startTime,
      endTime:         entry.endTime ?? "",
      contentType:     entry.contentType as ContentType,
      contentId:       entry.contentId ?? "",
      priorityOverride: entry.priorityOverride,
      isRecurring:     entry.isRecurring,
      isActive:        entry.isActive,
    });
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Schedule"
        description="Recurring weekly blocks and one-time broadcast events."
        actions={
          <Button size="sm" onClick={() => { setForm(BLANK_FORM); setAddOpen(true); }} className="gap-1.5">
            <Plus size={14} /> Add Entry
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      {upcoming.length > 0 && (
        <UpcomingEventsPanel entries={upcoming} onEdit={openEdit} onDelete={(id) => setDeleteId(id)} />
      )}

      <Tabs defaultValue="weekly">
        <TabsList>
          <TabsTrigger value="weekly" className="gap-1.5">
            <RotateCcw size={13} /> Weekly
          </TabsTrigger>
          <TabsTrigger value="onetime" className="gap-1.5">
            <CalendarClock size={13} /> One-time
            {oneTimeAll.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{oneTimeAll.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="weekly" className="mt-4">
          {isLoading ? (
            <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
          ) : recurring.length === 0 ? (
            <EmptyState message="No recurring weekly blocks" onAdd={() => { setForm(BLANK_FORM); setAddOpen(true); }} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[0,1,2,3,4,5,6].filter((d) => (byDay[d]?.length ?? 0) > 0).map((d) => (
                <Card key={d}>
                  <div className="px-4 pt-4 pb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold">{DAYS[d]}</span>
                    <Badge variant="secondary" className="text-xs">{byDay[d]!.length}</Badge>
                  </div>
                  <Separator />
                  <CardContent className="p-0 divide-y">
                    {byDay[d]!.map((e) => (
                      <EntryRow key={e.id} entry={e} onEdit={openEdit} onDelete={(id) => setDeleteId(id)} />
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="onetime" className="mt-4">
          {isLoading ? (
            <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
          ) : oneTimeAll.length === 0 ? (
            <EmptyState
              message="No one-time events"
              description="Schedule a specific video or stream to air on a particular date, interrupting the normal rotation."
              onAdd={() => { setForm({ ...BLANK_FORM, isOneTime: true }); setAddOpen(true); }}
            />
          ) : (
            <div className="space-y-2">
              {[...oneTimeAll].sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? "")).map((e) => (
                <OneTimeRow key={e.id} entry={e} onEdit={openEdit} onDelete={(id) => setDeleteId(id)} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <EntryDialog
        open={addOpen}
        title="Add Schedule Entry"
        form={form}
        setForm={setForm}
        isPending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        onClose={() => { setAddOpen(false); setForm(BLANK_FORM); }}
      />

      <EntryDialog
        open={editEntry !== null}
        title="Edit Schedule Entry"
        form={form}
        setForm={setForm}
        isPending={updateMutation.isPending}
        onSubmit={() => { if (editEntry) updateMutation.mutate({ id: editEntry.id, patch: form }); }}
        onClose={() => setEditEntry(null)}
      />

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove schedule entry?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this block from the schedule.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => { if (deleteId) deleteMutation.mutate(deleteId); }}
            >
              {deleteMutation.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UpcomingEventsPanel({
  entries, onEdit, onDelete,
}: {
  entries: ScheduleEntry[];
  onEdit: (e: ScheduleEntry) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <CalendarClock size={14} className="text-amber-600" />
        <span className="text-sm font-semibold text-amber-700">Upcoming Events</span>
        <Badge variant="outline" className="ml-auto text-[10px] border-amber-500/30 text-amber-700">{entries.length}</Badge>
      </div>
      <Separator className="bg-amber-500/20" />
      <CardContent className="p-0 divide-y divide-amber-500/10">
        {entries.slice(0, 5).map((e) => (
          <OneTimeRow key={e.id} entry={e} onEdit={onEdit} onDelete={onDelete} compact />
        ))}
        {entries.length > 5 && (
          <p className="px-4 py-2 text-xs text-muted-foreground">+{entries.length - 5} more — see One-time tab</p>
        )}
      </CardContent>
    </Card>
  );
}

function EntryRow({
  entry, onEdit, onDelete,
}: { entry: ScheduleEntry; onEdit: (e: ScheduleEntry) => void; onDelete: (id: string) => void }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 group">
      <div className="flex-shrink-0 pt-0.5 text-muted-foreground">{contentTypeIcon(entry.contentType)}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{entry.title}</p>
        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
          <Clock size={10} />
          {entry.startTime}{entry.endTime ? ` – ${entry.endTime}` : ""}
        </p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${statusBadge(entry.isActive)}`}>
            {entry.isActive ? "Active" : "Inactive"}
          </span>
          {entry.priorityOverride && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border bg-orange-500/10 text-orange-700 border-orange-500/20">
              <Zap size={9} /> Priority
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(entry)} aria-label={`Edit ${entry.title}`}>
          <Pencil size={12} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600" onClick={() => onDelete(entry.id)} aria-label={`Delete ${entry.title}`}>
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  );
}

function OneTimeRow({
  entry, onEdit, onDelete, compact = false,
}: { entry: ScheduleEntry; onEdit: (e: ScheduleEntry) => void; onDelete: (id: string) => void; compact?: boolean }) {
  const today = todayDateStr();
  const isPast = entry.scheduledDate ? entry.scheduledDate < today : false;
  const isToday = entry.scheduledDate === today;

  return (
    <div className={`flex items-center gap-3 px-4 ${compact ? "py-2.5" : "py-3"} group`}>
      <div className="flex-shrink-0 text-muted-foreground">{contentTypeIcon(entry.contentType)}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium truncate">{entry.title}</p>
          {isToday && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border bg-green-500/15 text-green-700 border-green-500/30">
              TODAY
            </span>
          )}
          {isPast && !isToday && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border bg-muted text-muted-foreground">
              Past
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1">
            <CalendarDays size={10} />
            {entry.scheduledDate ? formatScheduledDate(entry.scheduledDate) : "—"}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {entry.startTime}{entry.endTime ? ` – ${entry.endTime}` : ""}
          </span>
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {entry.priorityOverride && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border bg-orange-500/10 text-orange-700 border-orange-500/20">
            <Zap size={9} /> Priority
          </span>
        )}
        {!entry.isActive && (
          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border bg-muted text-muted-foreground">
            Fired
          </span>
        )}
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(entry)} aria-label={`Edit ${entry.title}`}>
            <Pencil size={12} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600" onClick={() => onDelete(entry.id)} aria-label={`Delete ${entry.title}`}>
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ message, description, onAdd }: { message: string; description?: string; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <CalendarDays size={36} className="text-muted-foreground/20" />
      <p className="font-semibold text-base">{message}</p>
      {description && <p className="text-sm text-muted-foreground max-w-xs">{description}</p>}
      <Button size="sm" onClick={onAdd} className="gap-1.5 mt-1">
        <Plus size={13} /> Add entry
      </Button>
    </div>
  );
}

function EntryDialog({
  open, title, form, setForm, isPending, onSubmit, onClose,
}: {
  open: boolean;
  title: string;
  form: typeof BLANK_FORM;
  setForm: React.Dispatch<React.SetStateAction<typeof BLANK_FORM>>;
  isPending: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const endTimeInvalid =
    form.endTime.length > 0 &&
    form.startTime.length > 0 &&
    form.endTime <= form.startTime;

  const externalUrlInvalid =
    form.contentType === "external" &&
    form.contentId.trim().length > 0 &&
    !/^https?:\/\/.+/i.test(form.contentId.trim());

  const dateInvalid =
    form.isOneTime && form.scheduledDate.length > 0 &&
    !/^\d{4}-\d{2}-\d{2}$/.test(form.scheduledDate);

  const canSubmit =
    form.title.trim().length > 0 &&
    form.startTime.length > 0 &&
    (!form.isOneTime || form.scheduledDate.length > 0) &&
    !endTimeInvalid &&
    !externalUrlInvalid &&
    !dateInvalid &&
    !isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Configure schedule block details</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <Label>Title *</Label>
            <Input
              placeholder="Sunday Morning Service"
              value={form.title}
              onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
            />
          </div>

          {/* One-time vs Recurring toggle */}
          <div className="flex items-center justify-between rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">One-time event</p>
              <p className="text-xs text-muted-foreground">
                {form.isOneTime ? "Fires once on the chosen date" : "Repeats every week"}
              </p>
            </div>
            <Switch
              checked={form.isOneTime}
              onCheckedChange={(v) => setForm(f => ({ ...f, isOneTime: v, scheduledDate: "" }))}
            />
          </div>

          {/* Date / Day of Week */}
          {form.isOneTime ? (
            <div className="space-y-1.5">
              <Label>Date *</Label>
              <Input
                type="date"
                value={form.scheduledDate}
                min={todayDateStr()}
                aria-invalid={dateInvalid}
                onChange={(e) => setForm(f => ({ ...f, scheduledDate: e.target.value }))}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Day of Week *</Label>
                <Select
                  value={String(form.dayOfWeek)}
                  onValueChange={(v) => setForm(f => ({ ...f, dayOfWeek: Number(v) }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Content Type *</Label>
                <Select
                  value={form.contentType}
                  onValueChange={(v) => setForm(f => ({ ...f, contentType: v as ContentType, priorityOverride: false }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTENT_TYPES.map((ct) => (
                      <SelectItem key={ct.value} value={ct.value}>{ct.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Content type for one-time (separate row) */}
          {form.isOneTime && (
            <div className="space-y-1.5">
              <Label>Content Type *</Label>
              <Select
                value={form.contentType}
                onValueChange={(v) => setForm(f => ({ ...f, contentType: v as ContentType, priorityOverride: false }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONTENT_TYPES.map((ct) => (
                    <SelectItem key={ct.value} value={ct.value}>{ct.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Start / End time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Start Time *</Label>
              <Input
                type="time"
                value={form.startTime}
                onChange={(e) => setForm(f => ({ ...f, startTime: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>End Time</Label>
              <Input
                type="time"
                aria-invalid={endTimeInvalid}
                value={form.endTime}
                onChange={(e) => setForm(f => ({ ...f, endTime: e.target.value }))}
              />
              {endTimeInvalid && (
                <p className="text-xs text-destructive">End time must be after start time.</p>
              )}
            </div>
          </div>

          {/* Content ID */}
          {(form.contentType === "video" || form.contentType === "playlist") && (
            <div className="space-y-1.5">
              <Label>Content ID</Label>
              <Input
                placeholder="Video or playlist ID"
                value={form.contentId}
                onChange={(e) => setForm(f => ({ ...f, contentId: e.target.value }))}
              />
            </div>
          )}
          {form.contentType === "external" && (
            <div className="space-y-1.5">
              <Label>Stream URL</Label>
              <Input
                placeholder="https://..."
                aria-invalid={externalUrlInvalid}
                value={form.contentId}
                onChange={(e) => setForm(f => ({ ...f, contentId: e.target.value }))}
              />
              {externalUrlInvalid && (
                <p className="text-xs text-destructive">Must be a valid https:// URL.</p>
              )}
            </div>
          )}

          {/* Priority Override — only for video type */}
          {form.contentType === "video" && (
            <div className="flex items-start justify-between rounded-lg border border-orange-500/30 bg-orange-500/5 px-4 py-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <Zap size={13} className="text-orange-600" />
                  <p className="text-sm font-medium">Priority Override</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Interrupt the current broadcast at the scheduled time. Requires the video to have an HLS stream. After the video ends, normal rotation resumes.
                </p>
              </div>
              <Switch
                className="ml-3 mt-0.5 shrink-0"
                checked={form.priorityOverride}
                onCheckedChange={(v) => setForm(f => ({ ...f, priorityOverride: v }))}
              />
            </div>
          )}

          {/* Recurring weekly toggle (only for non-one-time) */}
          {!form.isOneTime && (
            <div className="flex items-center justify-between rounded-lg border px-4 py-3">
              <div>
                <p className="text-sm font-medium">Recurring weekly</p>
                <p className="text-xs text-muted-foreground">Repeats every {DAYS[form.dayOfWeek]}</p>
              </div>
              <Switch checked={form.isRecurring} onCheckedChange={(v) => setForm(f => ({ ...f, isRecurring: v }))} />
            </div>
          )}

          {/* Active */}
          <div className="flex items-center justify-between rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">Include in the live broadcast schedule</p>
            </div>
            <Switch checked={form.isActive} onCheckedChange={(v) => setForm(f => ({ ...f, isActive: v }))} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
