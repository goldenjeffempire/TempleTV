import { useListAdminVideos, useImportVideo, useUpdateAdminVideo, useDeleteAdminVideo } from "@workspace/api-client-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Plus, Loader2, MoreVertical, Trash2, Youtube, ExternalLink, Video, Star, Edit } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getListAdminVideosQueryKey } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const CATEGORIES = ["sermon", "faith", "healing", "deliverance", "worship", "prophecy", "teachings", "special"];

type VideoRow = {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  category: string;
  preacher: string;
  featured: boolean;
  viewCount: number;
  duration: string;
  importedAt: string | Date;
};

export default function Videos() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useListAdminVideos({ search, limit: 50 });
  const [isImporting, setIsImporting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [editingVideo, setEditingVideo] = useState<VideoRow | null>(null);
  const importVideo = useImportVideo();
  const updateVideo = useUpdateAdminVideo();
  const deleteVideo = useDeleteAdminVideo();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editForm, setEditForm] = useState({ title: "", category: "sermon", preacher: "", featured: false });

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importUrl) return;

    let youtubeId = importUrl;
    if (importUrl.includes("youtube.com/watch?v=")) {
      youtubeId = importUrl.split("v=")[1].split("&")[0];
    } else if (importUrl.includes("youtu.be/")) {
      youtubeId = importUrl.split("youtu.be/")[1].split("?")[0];
    }

    setIsImporting(true);
    importVideo.mutate(
      { data: { youtubeId } },
      {
        onSuccess: () => {
          toast({ title: "Video imported successfully" });
          setImportUrl("");
          queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
        },
        onError: () => {
          toast({ title: "Failed to import video", variant: "destructive" });
        },
        onSettled: () => {
          setIsImporting(false);
        }
      }
    );
  };

  const handleDelete = (id: string) => {
    if (!confirm("Are you sure you want to delete this video?")) return;
    deleteVideo.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Video deleted" });
          queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
        },
        onError: () => {
          toast({ title: "Failed to delete video", variant: "destructive" });
        }
      }
    );
  };

  const openEdit = (video: VideoRow) => {
    setEditForm({
      title: video.title,
      category: video.category,
      preacher: video.preacher || "",
      featured: video.featured ?? false,
    });
    setEditingVideo(video);
  };

  const handleEditSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVideo) return;
    updateVideo.mutate(
      { id: editingVideo.id, data: editForm },
      {
        onSuccess: () => {
          toast({ title: "Video updated" });
          setEditingVideo(null);
          queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
        },
        onError: () => toast({ title: "Failed to update video", variant: "destructive" })
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Video Library</h1>
          <p className="text-muted-foreground mt-1">Manage sermons, teachings, and content.</p>
        </div>
        
        <form onSubmit={handleImport} className="flex w-full sm:w-auto items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Youtube className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              type="text" 
              placeholder="YouTube URL or ID..." 
              className="pl-9"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={isImporting || !importUrl}>
            {isImporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            Import
          </Button>
        </form>
      </div>

      <div className="bg-card border rounded-lg overflow-hidden">
        <div className="p-4 border-b bg-muted/20 flex gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              type="search" 
              placeholder="Search videos..." 
              className="pl-9 bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {isLoading ? (
          <div className="divide-y">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="p-4 flex gap-4">
                <Skeleton className="w-32 h-20 rounded-md" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-4 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : data?.videos.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
            <Video className="h-12 w-12 mb-4 opacity-20" />
            <p className="text-lg font-medium text-foreground">No videos found</p>
            <p className="text-sm mt-1">Try a different search term or import a new video.</p>
          </div>
        ) : (
          <div className="divide-y">
            {data?.videos.map((video) => (
              <div key={video.id} className="p-4 flex gap-4 group hover:bg-muted/30 transition-colors">
                <div className="relative w-32 h-20 shrink-0 bg-muted rounded-md overflow-hidden border">
                  <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
                  {video.duration && (
                    <div className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] px-1 py-0.5 rounded font-mono">
                      {video.duration}
                    </div>
                  )}
                  {video.featured && (
                    <div className="absolute top-1 left-1 bg-primary text-primary-foreground text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-0.5">
                      <Star className="w-2.5 h-2.5 fill-current" /> Featured
                    </div>
                  )}
                </div>
                
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <h3 className="font-semibold text-base truncate pr-4" title={video.title}>
                    {video.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground/80">{video.preacher || "Unknown"}</span>
                    <span>•</span>
                    <Badge variant="secondary" className="font-normal capitalize">{video.category}</Badge>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Youtube className="w-3.5 h-3.5" />
                      {video.viewCount?.toLocaleString() || 0} views
                    </span>
                    <span>•</span>
                    <span>Imported {new Date(video.importedAt).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="shrink-0 flex items-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="cursor-pointer" onClick={() => openEdit(video as VideoRow)}>
                        <Edit className="h-4 w-4 mr-2" />
                        Edit Details
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href={`https://youtube.com/watch?v=${video.youtubeId}`} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
                          <ExternalLink className="h-4 w-4 mr-2" />
                          View on YouTube
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer" onClick={() => handleDelete(video.id)}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!editingVideo} onOpenChange={(open) => !open && setEditingVideo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Video</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSave} className="space-y-4">
            {editingVideo && (
              <div className="flex gap-3 items-center p-3 bg-muted/30 rounded-lg border">
                <img src={editingVideo.thumbnailUrl} className="w-20 h-14 object-cover rounded" alt="" />
                <p className="text-sm font-medium line-clamp-2">{editingVideo.title}</p>
              </div>
            )}
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={editForm.title} onChange={e => setEditForm({ ...editForm, title: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label>Preacher / Speaker</Label>
              <Input value={editForm.preacher} onChange={e => setEditForm({ ...editForm, preacher: e.target.value })} placeholder="e.g. Pastor John" />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={editForm.category} onValueChange={v => setEditForm({ ...editForm, category: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between p-3 bg-muted/20 rounded-lg border">
              <div>
                <Label>Featured</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Highlights this video on the home screen</p>
              </div>
              <Switch checked={editForm.featured} onCheckedChange={c => setEditForm({ ...editForm, featured: c })} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setEditingVideo(null)}>Cancel</Button>
              <Button type="submit" className="flex-1" disabled={updateVideo.isPending}>
                {updateVideo.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Save Changes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
