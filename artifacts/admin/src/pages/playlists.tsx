import { useState } from "react";
import {
  useListPlaylists,
  useCreatePlaylist,
  useUpdatePlaylist,
  useDeletePlaylist,
  getListPlaylistsQueryKey,
  useGetPlaylist,
  useAddVideoToPlaylist,
  useRemoveVideoFromPlaylist,
  useReorderPlaylist,
  getGetPlaylistQueryKey,
  useListAdminVideos,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, ListVideo, Trash2, GripVertical, Loader2, X, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type LocalPlaylistVideo = {
  id: string;
  videoId: string;
  title: string;
  thumbnailUrl: string;
  category: string;
  duration: string;
};

function SortableVideoItem({
  video,
  index,
  onRemove,
}: {
  video: LocalPlaylistVideo;
  index: number;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: video.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 p-3 rounded-md bg-background border border-border hover:border-primary/30 group transition-colors"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 text-muted-foreground hover:text-foreground touch-none"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <span className="w-5 text-center text-xs text-muted-foreground font-medium shrink-0">{index + 1}</span>
      <div className="w-16 h-10 rounded overflow-hidden bg-muted shrink-0">
        <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate text-sm">{video.title}</div>
        <div className="text-xs text-muted-foreground mt-0.5 capitalize">{video.category}</div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 transition-opacity shrink-0"
        onClick={() => onRemove(video.id)}
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

export default function Playlists() {
  const { data: playlists, isLoading } = useListPlaylists();
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const createPlaylist = useCreatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const updatePlaylist = useUpdatePlaylist();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    loopMode: "sequential" as "none" | "sequential" | "random",
    isActive: true,
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createPlaylist.mutate(
      { data: formData },
      {
        onSuccess: () => {
          toast({ title: "Playlist created" });
          setIsCreateOpen(false);
          setFormData({ name: "", description: "", loopMode: "sequential", isActive: true });
          queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
        },
        onError: () => toast({ title: "Failed to create playlist", variant: "destructive" }),
      }
    );
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this playlist?")) return;
    deletePlaylist.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Playlist deleted" });
          if (selectedPlaylistId === id) setSelectedPlaylistId(null);
          queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
        },
      }
    );
  };

  const handleToggleActive = (id: string, isActive: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    updatePlaylist.mutate(
      { id, data: { isActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
        },
      }
    );
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-6">
      <div className="w-80 flex flex-col gap-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Playlists</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage video collections.</p>
          </div>

          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="w-4 h-4 mr-1.5" /> New
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Playlist</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g. Sunday Sermons"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Optional description..."
                    className="resize-none"
                    rows={3}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Playback Mode</Label>
                  <Select
                    value={formData.loopMode}
                    onValueChange={(v: "none" | "sequential" | "random") =>
                      setFormData({ ...formData, loopMode: v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sequential">Sequential (in order)</SelectItem>
                      <SelectItem value="random">Shuffle</SelectItem>
                      <SelectItem value="none">No loop</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/20 rounded-lg border">
                  <Label>Active</Label>
                  <Switch
                    checked={formData.isActive}
                    onCheckedChange={(c) => setFormData({ ...formData, isActive: c })}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={createPlaylist.isPending}>
                  {createPlaylist.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Create Playlist"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card border rounded-lg flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            Array(4)
              .fill(0)
              .map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
          ) : playlists?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              <ListVideo className="w-8 h-8 mx-auto mb-2 opacity-30" />
              No playlists yet.
            </div>
          ) : (
            playlists?.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPlaylistId(p.id)}
                className={`w-full text-left p-3 rounded-md transition-colors flex items-center gap-3 ${
                  selectedPlaylistId === p.id
                    ? "bg-primary/10 border-primary/20 border"
                    : "hover:bg-muted border border-transparent"
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${
                    p.isActive ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                  }`}
                >
                  <ListVideo className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate text-sm">{p.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {p.videoCount} videos · {p.loopMode}
                  </div>
                </div>
                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={p.isActive}
                    onCheckedChange={(c) => handleToggleActive(p.id, c, { stopPropagation: () => {} } as React.MouseEvent)}
                    className="scale-75"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:bg-destructive/10"
                    onClick={(evt) => handleDelete(p.id, evt)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 bg-card border rounded-lg flex flex-col min-w-0">
        {selectedPlaylistId ? (
          <PlaylistDetail id={selectedPlaylistId} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <ListVideo className="w-12 h-12 opacity-20" />
            <p className="text-sm">Select a playlist to manage its videos</p>
          </div>
        )}
      </div>
    </div>
  );
}

function PlaylistDetail({ id }: { id: string }) {
  const { data: playlist, isLoading } = useGetPlaylist(id, {
    query: { enabled: !!id, queryKey: getGetPlaylistQueryKey(id) },
  });
  const { data: allVideos } = useListAdminVideos({ limit: 100 });
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [videoSearch, setVideoSearch] = useState("");
  const addVideo = useAddVideoToPlaylist();
  const removeVideo = useRemoveVideoFromPlaylist();
  const reorderPlaylist = useReorderPlaylist();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !playlist) return;

    const videos = playlist.videos as unknown as LocalPlaylistVideo[];
    const oldIndex = videos.findIndex((v) => v.id === active.id);
    const newIndex = videos.findIndex((v) => v.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = arrayMove(videos, oldIndex, newIndex);
    const videoIds = newOrder.map((v) => v.id);

    reorderPlaylist.mutate(
      { id, data: { videoIds } },
      {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetPlaylistQueryKey(id) }),
        onError: () => toast({ title: "Failed to reorder", variant: "destructive" }),
      }
    );
  };

  const handleAddFromLibrary = (videoId: string) => {
    addVideo.mutate(
      { id, data: { videoId } },
      {
        onSuccess: () => {
          toast({ title: "Video added to playlist" });
          setIsAddOpen(false);
          setVideoSearch("");
          queryClient.invalidateQueries({ queryKey: getGetPlaylistQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
        },
        onError: () => toast({ title: "Failed to add video", variant: "destructive" }),
      }
    );
  };

  const handleRemove = (videoId: string) => {
    removeVideo.mutate(
      { id, videoId },
      {
        onSuccess: () => {
          toast({ title: "Video removed" });
          queryClient.invalidateQueries({ queryKey: getGetPlaylistQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
        },
      }
    );
  };

  const existingVideoIds = new Set((playlist?.videos as unknown as LocalPlaylistVideo[])?.map((v) => v.videoId) ?? []);
  const filteredLibrary = (allVideos?.videos ?? []).filter(
    (v) =>
      !existingVideoIds.has(v.id) &&
      (videoSearch === "" || v.title.toLowerCase().includes(videoSearch.toLowerCase()) || (v.preacher ?? "").toLowerCase().includes(videoSearch.toLowerCase()))
  );

  if (isLoading)
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (!playlist) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="p-5 border-b shrink-0 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold">{playlist.name}</h2>
          <p className="text-muted-foreground text-sm mt-1">{playlist.description || "No description."}</p>
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            <span>{playlist.videos.length} videos</span>
            <span>·</span>
            <span className="capitalize">Mode: {playlist.loopMode}</span>
          </div>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="w-4 h-4 mr-1.5" /> Add Video
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Video from Library</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search your video library..."
                  value={videoSearch}
                  onChange={(e) => setVideoSearch(e.target.value)}
                />
              </div>
              <div className="max-h-72 overflow-y-auto space-y-1 border rounded-lg p-1">
                {filteredLibrary.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {allVideos?.videos.length === 0
                      ? "No videos in your library yet. Import some first."
                      : "All videos are already in this playlist."}
                  </p>
                ) : (
                  filteredLibrary.map((video) => (
                    <button
                      key={video.id}
                      onClick={() => handleAddFromLibrary(video.id)}
                      disabled={addVideo.isPending}
                      className="w-full flex items-center gap-3 p-2.5 rounded-md hover:bg-muted text-left transition-colors"
                    >
                      <img src={video.thumbnailUrl} className="w-14 h-9 object-cover rounded shrink-0" alt="" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{video.title}</p>
                        <p className="text-xs text-muted-foreground capitalize">{video.category}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {playlist.videos.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <ListVideo className="w-10 h-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm">No videos yet. Click "Add Video" to get started.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={(playlist.videos as unknown as LocalPlaylistVideo[]).map((v) => v.id)}
              strategy={verticalListSortingStrategy}
            >
              {(playlist.videos as unknown as LocalPlaylistVideo[]).map((video, index) => (
                <SortableVideoItem
                  key={video.id}
                  video={video}
                  index={index}
                  onRemove={handleRemove}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
