import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  BookOpen, Plus, MoreVertical, Pencil, Trash2, List,
  Eye, EyeOff, RefreshCw, Search, X, Film, GripVertical,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SeriesRow {
  id: string;
  title: string;
  slug: string;
  description: string;
  thumbnailUrl: string;
  bannerUrl: string | null;
  preacher: string | null;
  category: string;
  isPublished: boolean;
  isOngoing: boolean;
  sortOrder: number;
  episodeCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface EpisodeRow {
  id: string;
  seriesId: string;
  videoId: string;
  episodeNumber: number;
  title: string | null;
  description: string | null;
  addedAt: string;
}

interface AdminVideo {
  id: string;
  title: string;
  thumbnailUrl: string;
  duration: string | null;
  category: string | null;
  preacher: string | null;
  youtubeId: string | null;
}

interface SeriesFormState {
  title: string;
  slug: string;
  preacher: string;
  category: string;
  description: string;
  thumbnailUrl: string;
  isPublished: boolean;
  isOngoing: boolean;
  sortOrder: number;
}

const BLANK_FORM: SeriesFormState = {
  title: "",
  slug: "",
  preacher: "",
  category: "sermon",
  description: "",
  thumbnailUrl: "",
  isPublished: false,
  isOngoing: true,
  sortOrder: 0,
};

const CATEGORIES = [
  "sermon", "teaching", "worship", "prayer", "devotional", "conference", "special",
];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "series";
}

// ── Episode Management Dialog ──────────────────────────────────────────────────

function EpisodesDialog({
  series,
  onClose,
}: {
  series: SeriesRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [videoSearch, setVideoSearch] = useState("");
  const [removePendingEpId, setRemovePendingEpId] = useState<string | null>(null);

  const { data: episodesData, isLoading: epLoading } = useQuery({
    queryKey: ["series-episodes", series.id],
    queryFn: () =>
      api.get<{ id: string; slug: string; episodes: EpisodeRow[] }>(
        `/series/${series.slug}`,
      ).then((d) => d.episodes),
    staleTime: 30_000,
  });

  const { data: videosData } = useQuery({
    queryKey: ["video-search-series", videoSearch],
    queryFn: () => {
      const p = new URLSearchParams({ limit: "20" });
      if (videoSearch) p.set("search", videoSearch);
      return api.get<{ videos: AdminVideo[] }>(`/admin/videos?${p}`);
    },
    staleTime: 30_000,
  });

  const addEpisodeMutation = useMutation({
    mutationFn: ({ videoId, episodeNumber }: { videoId: string; episodeNumber?: number }) =>
      api.post(`/admin/series/${series.id}/episodes`, { videoId, episodeNumber }),
    onSuccess: () => {
      toast.success("Episode added");
      void qc.invalidateQueries({ queryKey: ["series-episodes", series.id] });
      void qc.invalidateQueries({ queryKey: ["series"] });
      // Keep dashboard episode-count stats accurate after adding episodes.
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to add episode"),
  });

  const removeEpisodeMutation = useMutation({
    mutationFn: (episodeId: string) =>
      api.delete(`/admin/series/${series.id}/episodes/${episodeId}`),
    onSuccess: () => {
      toast.success("Episode removed");
      void qc.invalidateQueries({ queryKey: ["series-episodes", series.id] });
      void qc.invalidateQueries({ queryKey: ["series"] });
      // Keep dashboard episode-count stats accurate after removing episodes.
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to remove episode"),
  });

  const episodes = episodesData ?? [];
  const videos = videosData?.videos ?? [];
  const episodeVideoIds = new Set(episodes.map((e) => e.videoId));

  return (
    <>
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="text-base">
            Episodes — <span className="font-normal text-muted-foreground">{series.title}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">Manage episodes in this series</DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: current episodes */}
          <div className="flex flex-col w-1/2 border-r min-h-0">
            <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between flex-shrink-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Current Episodes ({episodes.length})
              </p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {epLoading ? (
                <div className="space-y-2 p-4">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-12" />)}
                </div>
              ) : episodes.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-12 text-center px-4">
                  <Film size={28} className="text-muted-foreground/20" />
                  <p className="text-sm text-muted-foreground">No episodes yet</p>
                  <p className="text-xs text-muted-foreground">Search for videos on the right to add them.</p>
                </div>
              ) : (
                <div className="divide-y">
                  {[...episodes]
                    .sort((a, b) => a.episodeNumber - b.episodeNumber)
                    .map((ep) => (
                      <div key={ep.id} className="flex items-center gap-3 px-4 py-3">
                        <GripVertical size={14} className="text-muted-foreground/30 flex-shrink-0" />
                        <span className="text-xs font-mono text-muted-foreground w-5 flex-shrink-0">
                          {ep.episodeNumber}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">
                            {ep.title ?? `Episode ${ep.episodeNumber}`}
                          </p>
                          <p className="text-[11px] text-muted-foreground font-mono truncate">
                            {ep.videoId}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-destructive"
                          disabled={removeEpisodeMutation.isPending}
                          onClick={() => setRemovePendingEpId(ep.id)}
                        >
                          <X size={13} />
                        </Button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: video picker */}
          <div className="flex flex-col w-1/2 min-h-0">
            <div className="px-4 py-3 border-b bg-muted/30 flex-shrink-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Add from Library
              </p>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search videos…"
                  value={videoSearch}
                  onChange={(e) => setVideoSearch(e.target.value)}
                  className="pl-7 h-7 text-xs"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto divide-y">
              {videos.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
                  <Film size={24} className="text-muted-foreground/20" />
                  <p className="text-xs text-muted-foreground">No videos found</p>
                </div>
              ) : (
                videos.map((v) => {
                  const alreadyAdded = episodeVideoIds.has(v.id);
                  return (
                    <div key={v.id} className="flex items-center gap-3 px-4 py-2.5">
                      {v.thumbnailUrl ? (
                        <img
                          src={v.thumbnailUrl}
                          alt=""
                          className="w-12 h-8 object-contain rounded flex-shrink-0 bg-black"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <div className="w-12 h-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                          <Film size={12} className="text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{v.title}</p>
                        {v.preacher && (
                          <p className="text-[11px] text-muted-foreground truncate">{v.preacher}</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={alreadyAdded ? "outline" : "default"}
                        className="h-6 text-[11px] px-2 flex-shrink-0"
                        disabled={alreadyAdded || addEpisodeMutation.isPending}
                        onClick={() => addEpisodeMutation.mutate({ videoId: v.id })}
                      >
                        {alreadyAdded ? "Added" : "Add"}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-3 border-t flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>

    {/* Confirm removal — prevents accidental single-click episode removal */}
    <AlertDialog
      open={removePendingEpId !== null}
      onOpenChange={(o) => { if (!o) setRemovePendingEpId(null); }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove episode?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the episode from this series. The video itself will not be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              if (removePendingEpId) removeEpisodeMutation.mutate(removePendingEpId);
              setRemovePendingEpId(null);
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

// ── Series Form Dialog ─────────────────────────────────────────────────────────

function SeriesFormDialog({
  editing,
  onClose,
  onCreate,
  onUpdate,
  isPending,
}: {
  editing: SeriesRow | null;
  onClose: () => void;
  onCreate: (form: SeriesFormState) => void;
  onUpdate: (id: string, form: SeriesFormState) => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<SeriesFormState>(BLANK_FORM);
  const [slugManual, setSlugManual] = useState(false);

  useEffect(() => {
    if (editing) {
      setForm({
        title: editing.title,
        slug: editing.slug,
        preacher: editing.preacher ?? "",
        category: editing.category,
        description: editing.description,
        thumbnailUrl: editing.thumbnailUrl,
        isPublished: editing.isPublished,
        isOngoing: editing.isOngoing,
        sortOrder: editing.sortOrder,
      });
      setSlugManual(true);
    } else {
      setForm(BLANK_FORM);
      setSlugManual(false);
    }
  }, [editing]);

  const set = <K extends keyof SeriesFormState>(key: K, val: SeriesFormState[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const handleTitleChange = (v: string) => {
    setForm((f) => ({
      ...f,
      title: v,
      slug: slugManual ? f.slug : slugify(v),
    }));
  };

  const handleSubmit = () => {
    if (editing) onUpdate(editing.id, form);
    else onCreate(form);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Series" : "New Series"}</DialogTitle>
          <DialogDescription className="sr-only">
            {editing ? "Update series metadata" : "Create a new sermon series"}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
          className="space-y-4"
        >
          {/* Title */}
          <div className="space-y-1.5">
            <Label>Title <span className="text-destructive">*</span></Label>
            <Input
              placeholder="e.g., Faith Foundations"
              value={form.title}
              onChange={(e) => handleTitleChange(e.target.value)}
            />
          </div>

          {/* Slug */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              URL Slug
              <span className="text-[11px] text-muted-foreground font-normal">(auto-generated)</span>
            </Label>
            <Input
              placeholder="faith-foundations"
              value={form.slug}
              onChange={(e) => { setSlugManual(true); set("slug", slugify(e.target.value)); }}
              className="font-mono text-sm"
            />
          </div>

          {/* Preacher + Category row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Preacher</Label>
              <Input
                placeholder="e.g., Pastor John"
                value={form.preacher}
                onChange={(e) => set("preacher", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(v) => set("category", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              rows={3}
              placeholder="What is this series about?"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          {/* Thumbnail URL */}
          <div className="space-y-1.5">
            <Label>Thumbnail URL</Label>
            <Input
              placeholder="https://…"
              value={form.thumbnailUrl}
              onChange={(e) => set("thumbnailUrl", e.target.value)}
            />
            {form.thumbnailUrl && (
              <img
                src={form.thumbnailUrl}
                alt="thumbnail preview"
                className="h-16 rounded object-contain bg-black"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            )}
          </div>

          <Separator />

          {/* Toggles row */}
          <div className="flex gap-6">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <Switch
                checked={form.isPublished}
                onCheckedChange={(v) => set("isPublished", v)}
              />
              <span className="text-sm font-medium">Published</span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <Switch
                checked={form.isOngoing}
                onCheckedChange={(v) => set("isOngoing", v)}
              />
              <span className="text-sm font-medium">Ongoing</span>
            </label>
          </div>

          {/* Sort order */}
          <div className="space-y-1.5">
            <Label>Sort Order <span className="text-xs text-muted-foreground font-normal">(lower = first)</span></Label>
            <Input
              type="number"
              min={0}
              value={form.sortOrder}
              onChange={(e) => set("sortOrder", parseInt(e.target.value) || 0)}
              className="w-28"
            />
          </div>

          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              disabled={isPending || !form.title.trim() || !form.slug.trim()}
            >
              {isPending ? "Saving…" : editing ? "Save changes" : "Create series"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SeriesPage() {
  const qc = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SeriesRow | null>(null);
  const [deleting, setDeleting] = useState<SeriesRow | null>(null);
  const [managingEpisodes, setManagingEpisodes] = useState<SeriesRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["series"],
    queryFn: () => api.get<SeriesRow[]>("/admin/series"),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (form: SeriesFormState) => api.post("/admin/series", form),
    onSuccess: () => {
      toast.success("Series created");
      void qc.invalidateQueries({ queryKey: ["series"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setFormOpen(false);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to create"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, form }: { id: string; form: SeriesFormState }) =>
      api.patch(`/admin/series/${id}`, form),
    onSuccess: () => {
      toast.success("Series updated");
      void qc.invalidateQueries({ queryKey: ["series"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/series/${id}`),
    onSuccess: (_data, id) => {
      toast.success("Series deleted");
      void qc.invalidateQueries({ queryKey: ["series"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      void qc.invalidateQueries({ queryKey: ["series-episodes", id] });
      setDeleting(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to delete"),
  });

  const togglePublishMutation = useMutation({
    mutationFn: ({ id, isPublished }: { id: string; isPublished: boolean }) =>
      api.patch(`/admin/series/${id}`, { isPublished }),
    onSuccess: (_, { id, isPublished }) => {
      toast.success(isPublished ? "Series published" : "Series unpublished");
      void qc.invalidateQueries({ queryKey: ["series"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      // Keep the episode detail panel in sync — publish state is shown there too.
      void qc.invalidateQueries({ queryKey: ["series-episodes", id] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update"),
  });

  const seriesList = data ?? [];

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Sermon Series"
        description={`${seriesList.length} series`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
              <RefreshCw size={13} /> Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => { setEditing(null); setFormOpen(true); }}
              className="gap-1.5"
            >
              <Plus size={14} /> New Series
            </Button>
          </div>
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
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map((i) => <Skeleton key={i} className="h-52" />)}
        </div>
      ) : seriesList.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <BookOpen size={40} className="text-muted-foreground/20" />
          <p className="font-semibold text-lg">No series yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Create sermon series to group related videos together for viewers on TV, mobile, and web.
          </p>
          <Button
            size="sm"
            onClick={() => { setEditing(null); setFormOpen(true); }}
            className="gap-1.5 mt-2"
          >
            <Plus size={13} /> Create first series
          </Button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {seriesList.map((s) => (
            <Card key={s.id} className="flex flex-col overflow-hidden group">
              {/* Thumbnail */}
              <div className="relative h-32 bg-black overflow-hidden flex-shrink-0">
                {s.thumbnailUrl ? (
                  <img
                    src={s.thumbnailUrl}
                    alt={s.title}
                    className="w-full h-full object-contain transition-transform duration-300"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <BookOpen size={28} className="text-muted-foreground/20" />
                  </div>
                )}

                {/* Status badges */}
                <div className="absolute top-2 left-2 flex gap-1.5">
                  {s.isPublished ? (
                    <Badge className="text-[10px] px-1.5 py-0.5 bg-green-600/90 text-white border-0">
                      Published
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5">
                      Draft
                    </Badge>
                  )}
                  {s.isOngoing && (
                    <Badge className="text-[10px] px-1.5 py-0.5 bg-blue-600/90 text-white border-0">
                      Ongoing
                    </Badge>
                  )}
                </div>

                {/* Actions menu */}
                <div className="absolute top-2 right-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 bg-black/50 hover:bg-black/70 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <MoreVertical size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => { setEditing(s); setFormOpen(true); }}>
                        <Pencil size={13} className="mr-2" /> Edit metadata
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setManagingEpisodes(s)}>
                        <List size={13} className="mr-2" /> Manage episodes
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => togglePublishMutation.mutate({ id: s.id, isPublished: !s.isPublished })}
                        disabled={togglePublishMutation.isPending}
                      >
                        {s.isPublished
                          ? <><EyeOff size={13} className="mr-2" /> Unpublish</>
                          : <><Eye size={13} className="mr-2" /> Publish</>}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleting(s)}
                      >
                        <Trash2 size={13} className="mr-2" /> Delete series
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Body */}
              <CardContent className="p-4 flex flex-col gap-2 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{s.title}</p>
                    {s.preacher && (
                      <p className="text-xs text-muted-foreground truncate">{s.preacher}</p>
                    )}
                  </div>
                </div>

                {s.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {s.description}
                  </p>
                )}

                <div className="flex items-center justify-between mt-auto pt-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[11px] gap-1">
                      <Film size={10} />
                      {s.episodeCount} ep.
                    </Badge>
                    <Badge variant="outline" className="text-[11px] capitalize">
                      {s.category}
                    </Badge>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}
                  </span>
                </div>

                {/* Quick actions */}
                <div className="flex gap-1.5 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-7 text-xs gap-1"
                    onClick={() => setManagingEpisodes(s)}
                  >
                    <List size={12} /> Episodes
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-7 text-xs gap-1"
                    onClick={() => { setEditing(s); setFormOpen(true); }}
                  >
                    <Pencil size={12} /> Edit
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      {(formOpen || !!editing) && (
        <SeriesFormDialog
          editing={editing}
          onClose={() => { setFormOpen(false); setEditing(null); }}
          onCreate={(form) => createMutation.mutate(form)}
          onUpdate={(id, form) => updateMutation.mutate({ id, form })}
          isPending={createMutation.isPending || updateMutation.isPending}
        />
      )}

      {/* Episode management dialog */}
      {managingEpisodes && (
        <EpisodesDialog
          series={managingEpisodes}
          onClose={() => setManagingEpisodes(null)}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete series permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleting?.title}</strong> and all its episode assignments will be permanently
              removed. The underlying videos are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
