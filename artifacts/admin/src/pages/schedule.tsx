import { useState } from "react";
import { useListSchedule, useCreateScheduleEntry, useUpdateScheduleEntry, useDeleteScheduleEntry, getListScheduleQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Plus, Loader2, Calendar as CalendarIcon, Clock, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function Schedule() {
  const { data: schedule, isLoading } = useListSchedule();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const createEntry = useCreateScheduleEntry();
  const deleteEntry = useDeleteScheduleEntry();
  const updateEntry = useUpdateScheduleEntry();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    title: "", dayOfWeek: 0, startTime: "09:00", endTime: "10:30", contentType: "live" as any, contentId: "", isRecurring: true, isActive: true
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createEntry.mutate({ data: formData }, {
      onSuccess: () => {
        toast({ title: "Schedule entry created" });
        setIsCreateOpen(false);
        queryClient.invalidateQueries({ queryKey: getListScheduleQueryKey() });
      },
      onError: () => toast({ title: "Failed to create schedule entry", variant: "destructive" })
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm("Delete this schedule entry?")) return;
    deleteEntry.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Entry deleted" });
        queryClient.invalidateQueries({ queryKey: getListScheduleQueryKey() });
      }
    });
  };

  const handleToggle = (id: string, isActive: boolean) => {
    updateEntry.mutate({ id, data: { isActive } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListScheduleQueryKey() });
      }
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
                  <Select value={formData.contentType} onValueChange={v => setFormData({...formData, contentType: v})}>
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

      <div className="grid gap-6 lg:grid-cols-7">
        {DAYS.map((day, dayIndex) => {
          const dayEntries = schedule?.filter(e => e.dayOfWeek === dayIndex).sort((a, b) => a.startTime.localeCompare(b.startTime)) || [];
          
          return (
            <div key={day} className="flex flex-col gap-3">
              <div className="font-semibold text-sm pb-2 border-b">{day}</div>
              {isLoading ? (
                <Skeleton className="h-24 w-full rounded-lg" />
              ) : dayEntries.length === 0 ? (
                <div className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-lg bg-muted/10">No events</div>
              ) : (
                dayEntries.map(entry => (
                  <div key={entry.id} className={`p-3 rounded-lg border text-sm relative group transition-colors ${entry.isActive ? 'bg-card border-border hover:border-primary/50' : 'bg-muted/50 border-transparent opacity-60'}`}>
                    <div className="flex items-start justify-between mb-1">
                      <div className="font-medium truncate pr-4">{entry.title}</div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 top-2 bg-background/80 p-1 rounded-md backdrop-blur-sm">
                        <Switch checked={entry.isActive} onCheckedChange={c => handleToggle(entry.id, c)} className="scale-75" />
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:bg-destructive/10" onClick={() => handleDelete(entry.id)}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2">
                      <Clock className="w-3 h-3" />
                      {entry.startTime} {entry.endTime && `- ${entry.endTime}`}
                    </div>
                    <div className="mt-2 inline-flex text-[10px] font-medium px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground uppercase tracking-wider">
                      {entry.contentType}
                    </div>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
