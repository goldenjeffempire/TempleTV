import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
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
import { CalendarDays, Plus, Pencil, Trash2, Clock, Radio, Tv, Video, Link2 } from "lucide-react";

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
  dayOfWeek: number;
  startTime: string;
  endTime: string | null;
  contentType: string;
  contentId: string | null;
  isRecurring: boolean;
  isActive: boolean;
  createdAt: string;
}

const BLANK_FORM = {
  title: "",
  dayOfWeek: 1,
  startTime: "09:00",
  endTime: "",
  contentType: "live" as ContentType,
  contentId: "",
  isRecurring: true,
  isActive: true,
};

function contentTypeIcon(ct: string) {
  const found = CONTENT_TYPES.find((c) => c.value === ct);
  const Icon = found?.icon ?? Tv;
  return <Icon size={13} className="shrink-0" />;
}

function healthColor(isActive: boolean) {
  return isActive ? "bg-green-500/15 text-green-700 border-green-500/30" : "bg-muted text-muted-foreground";
}

export default function SchedulePage() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen]   = useState(false);
  const [editEntry, setEditEntry] = useState<ScheduleEntry | null>(null);
  const [deleteId, setDeleteId]  = useState<string | null>(null);
  const [form, setForm] = useState(BLANK_FORM);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["schedule"],
    queryFn:  () => api.get<{ items: ScheduleEntry[]; total: number }>("/schedule"),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof BLANK_FORM) =>
      api.post<ScheduleEntry>("/schedule", {
        ...body,
        endTime:   body.endTime.trim() || null,
        contentId: body.contentId.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Schedule entry created");
      void qc.invalidateQueries({ queryKey: ["schedule"] });
      // The broadcast queue panel displays schedule labels; keep it in sync.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      setAddOpen(false);
      setForm(BLANK_FORM);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to create entry"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<typeof BLANK_FORM> }) =>
      api.patch<ScheduleEntry>(`/schedule/${id}`, {
        ...patch,
        endTime:   patch.endTime !== undefined ? (patch.endTime.trim() || null) : undefined,
        contentId: patch.contentId !== undefined ? (patch.contentId.trim() || null) : undefined,
      }),
    onSuccess: () => {
      toast.success("Schedule entry updated");
      void qc.invalidateQueries({ queryKey: ["schedule"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      setEditEntry(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update entry"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/schedule/${id}`),
    onSuccess: () => {
      toast.success("Removed from schedule");
      void qc.invalidateQueries({ queryKey: ["schedule"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      setDeleteId(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to delete"),
  });

  const items = data?.items ?? [];

  const byDay: Record<number, ScheduleEntry[]> = {};
  for (let d = 0; d < 7; d++) byDay[d] = [];
  for (const e of items) byDay[e.dayOfWeek]?.push(e);
  for (let d = 0; d < 7; d++) byDay[d]?.sort((a, b) => a.startTime.localeCompare(b.startTime));

  function openEdit(entry: ScheduleEntry) {
    setEditEntry(entry);
    setForm({
      title:       entry.title,
      dayOfWeek:   entry.dayOfWeek,
      startTime:   entry.startTime,
      endTime:     entry.endTime ?? "",
      contentType: entry.contentType as ContentType,
      contentId:   entry.contentId ?? "",
      isRecurring: entry.isRecurring,
      isActive:    entry.isActive,
    });
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Schedule"
        description="Weekly programming schedule — recurring blocks that drive the live broadcast grid."
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

      {isLoading ? (
        <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <CalendarDays size={40} className="text-muted-foreground/20" />
          <p className="font-semibold text-lg">No scheduled content</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Add recurring weekly blocks to plan your broadcast programming.
          </p>
          <Button size="sm" onClick={() => { setForm(BLANK_FORM); setAddOpen(true); }} className="gap-1.5 mt-1">
            <Plus size={13} /> Add first entry
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0,1,2,3,4,5,6].filter(d => (byDay[d]?.length ?? 0) > 0).map((d) => (
            <Card key={d}>
              <div className="px-4 pt-4 pb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">{DAYS[d]}</span>
                <Badge variant="secondary" className="text-xs">{byDay[d]!.length} block{byDay[d]!.length !== 1 ? "s" : ""}</Badge>
              </div>
              <Separator />
              <CardContent className="p-0 divide-y">
                {byDay[d]!.map((e) => (
                  <div key={e.id} className="flex items-start gap-3 px-4 py-3 group">
                    <div className="flex-shrink-0 pt-0.5 text-muted-foreground">
                      {contentTypeIcon(e.contentType)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{e.title}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock size={10} />
                        {e.startTime}{e.endTime ? ` – ${e.endTime}` : ""}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${healthColor(e.isActive)}`}>
                          {e.isActive ? "Active" : "Inactive"}
                        </span>
                        {e.isRecurring && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border bg-blue-500/10 text-blue-700 border-blue-500/20">
                            Weekly
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(e)} aria-label={`Edit schedule entry ${e.title ?? ""}`.trim()} title="Edit">
                        <Pencil size={12} />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600" onClick={() => setDeleteId(e.id)} aria-label={`Delete schedule entry ${e.title ?? ""}`.trim()} title="Delete">
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
  const canSubmit = form.title.trim().length > 0 && form.startTime.length > 0 && !isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Configure schedule block details</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Title *</Label>
            <Input
              placeholder="Sunday Morning Service"
              value={form.title}
              onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Day of Week *</Label>
              <Select value={String(form.dayOfWeek)} onValueChange={(v) => setForm(f => ({ ...f, dayOfWeek: Number(v) }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Content Type *</Label>
              <Select value={form.contentType} onValueChange={(v) => setForm(f => ({ ...f, contentType: v as ContentType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONTENT_TYPES.map((ct) => (
                    <SelectItem key={ct.value} value={ct.value}>{ct.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

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
                value={form.endTime}
                onChange={(e) => setForm(f => ({ ...f, endTime: e.target.value }))}
              />
            </div>
          </div>

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
                value={form.contentId}
                onChange={(e) => setForm(f => ({ ...f, contentId: e.target.value }))}
              />
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Recurring weekly</p>
              <p className="text-xs text-muted-foreground">Repeats every {DAYS[form.dayOfWeek]}</p>
            </div>
            <Switch checked={form.isRecurring} onCheckedChange={(v) => setForm(f => ({ ...f, isRecurring: v }))} />
          </div>

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
