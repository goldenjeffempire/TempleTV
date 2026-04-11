import { useState } from "react";
import { useListPlaylists, useCreatePlaylist, useUpdatePlaylist, useDeletePlaylist, getListPlaylistsQueryKey, useGetPlaylist, useAddVideoToPlaylist, useRemoveVideoFromPlaylist, useReorderPlaylist, getGetPlaylistQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, ListVideo, Trash2, Edit2, GripVertical, PlayCircle, Loader2, X, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export default function Playlists() {
  const { data: playlists, isLoading } = useListPlaylists();
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  
  const createPlaylist = useCreatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const updatePlaylist = useUpdatePlaylist();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({ name: "", description: "", loopMode: "none" as "none" | "sequential" | "random", isActive: true });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createPlaylist.mutate(
      { data: formData },
      {
        onSuccess: () => {
          toast({ title: "Playlist created" });
          setIsCreateOpen(false);
          setFormData({ name: "", description: "", loopMode: "none", isActive: true });
          queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
        },
        onError: () => toast({ title: "Failed to create playlist", variant: "destructive" })
      }
    );
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete playlist?")) return;
    deletePlaylist.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Playlist deleted" });
        if (selectedPlaylistId === id) setSelectedPlaylistId(null);
        queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
      }
    });
  };

  const handleToggleActive = (id: string, isActive: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    updatePlaylist.mutate({ id, data: { isActive } }, {
      onSuccess: () => {
        toast({ title: isActive ? "Playlist activated" : "Playlist deactivated" });
        queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
      }
    });
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-6">
      <div className="w-1/3 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Playlists</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage video collections.</p>
          </div>
          
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="w-4 h-4 mr-2" /> New</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create Playlist</DialogTitle></DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} required />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} />
                </div>
                <div className="space-y-2">
                  <Label>Loop Mode</Label>
                  <Select value={formData.loopMode} onValueChange={(v: any) => setFormData({...formData, loopMode: v})}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="sequential">Sequential</SelectItem>
                      <SelectItem value="random">Random</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <Label>Active</Label>
                  <Switch checked={formData.isActive} onCheckedChange={c => setFormData({...formData, isActive: c})} />
                </div>
                <Button type="submit" className="w-full" disabled={createPlaylist.isPending}>
                  {createPlaylist.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Create"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card border rounded-lg flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
          ) : playlists?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">No playlists found.</div>
          ) : (
            playlists?.map(p => (
              <button
                key={p.id}
                onClick={() => setSelectedPlaylistId(p.id)}
                className={`w-full text-left p-3 rounded-md transition-colors flex items-center gap-3 ${selectedPlaylistId === p.id ? 'bg-primary/10 border-primary/20 border' : 'hover:bg-muted border border-transparent'}`}
              >
                <div className={`w-10 h-10 rounded flex items-center justify-center shrink-0 ${p.isActive ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  <ListVideo className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{p.videoCount} videos • {p.loopMode}</div>
                </div>
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <Switch checked={p.isActive} onCheckedChange={c => handleToggleActive(p.id, c, e)} />
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={(evt) => handleDelete(p.id, evt)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 bg-card border rounded-lg flex flex-col">
        {selectedPlaylistId ? (
          <PlaylistDetail id={selectedPlaylistId} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <ListVideo className="w-12 h-12 mb-4 opacity-20" />
            <p>Select a playlist to view its videos</p>
          </div>
        )}
      </div>
    </div>
  );
}

function PlaylistDetail({ id }: { id: string }) {
  const { data: playlist, isLoading } = useGetPlaylist(id, { query: { enabled: !!id, queryKey: getGetPlaylistQueryKey(id) } });
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const addVideo = useAddVideoToPlaylist();
  const removeVideo = useRemoveVideoFromPlaylist();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!videoUrl) return;
    
    let videoId = videoUrl;
    if (videoUrl.includes("v=")) videoId = videoUrl.split("v=")[1].split("&")[0];
    else if (videoUrl.includes("youtu.be/")) videoId = videoUrl.split("youtu.be/")[1].split("?")[0];

    addVideo.mutate({ id, data: { videoId } }, {
      onSuccess: () => {
        toast({ title: "Video added" });
        setVideoUrl("");
        setIsAddOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetPlaylistQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
      },
      onError: () => toast({ title: "Failed to add video", variant: "destructive" })
    });
  };

  const handleRemove = (videoId: string) => {
    removeVideo.mutate({ id, videoId }, {
      onSuccess: () => {
        toast({ title: "Video removed" });
        queryClient.invalidateQueries({ queryKey: getGetPlaylistQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListPlaylistsQueryKey() });
      }
    });
  };

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-8 w-1/3" /><Skeleton className="h-4 w-1/2" /></div>;
  if (!playlist) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b shrink-0 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">{playlist.name}</h2>
          <p className="text-muted-foreground mt-1">{playlist.description || "No description."}</p>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="w-4 h-4 mr-2" /> Add Video</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add Video</DialogTitle></DialogHeader>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="space-y-2">
                <Label>YouTube URL or Video ID</Label>
                <Input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..." required />
              </div>
              <Button type="submit" className="w-full" disabled={addVideo.isPending}>
                {addVideo.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Add Video"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {playlist.videos.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">No videos in this playlist.</div>
        ) : (
          playlist.videos.map((video, index) => (
            <div key={video.id} className="flex items-center gap-3 p-3 rounded-md hover:bg-muted group border border-transparent hover:border-border transition-colors">
              <GripVertical className="w-4 h-4 text-muted-foreground cursor-grab opacity-0 group-hover:opacity-100" />
              <span className="w-6 text-center text-sm text-muted-foreground font-medium">{index + 1}</span>
              <div className="w-20 h-12 rounded overflow-hidden bg-muted shrink-0 relative">
                <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate text-sm">{video.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">{video.category} • {video.duration}</div>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 transition-opacity" onClick={() => handleRemove(video.id)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
