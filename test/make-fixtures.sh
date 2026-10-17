#!/usr/bin/env bash
# Synthetic recording: a fake "screen" (1280x720), a fake webcam (640x480) and a pointer log.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" -f lavfi -i "sine=frequency=440:duration=12" \
  -vf "drawbox=x=0:y=0:w=1280:h=56:color=0x1f2937@1:t=fill,drawbox=x=40:y=120:w=360:h=200:color=white@0.9:t=fill,drawbox=x=880:y=520:w=300:h=120:color=0x3b82f6@1:t=fill" \
  -c:v libvpx-vp9 -b:v 2M -deadline realtime -cpu-used 8 -c:a libopus fixtures/screen.webm
ffmpeg -y -loglevel error -f lavfi -i "smptebars=size=640x480:rate=30:duration=12" \
  -vf "drawbox=x='200+100*sin(t)':y=140:w=240:h=200:color=0xf59e0b@1:t=fill" -c:v libvpx-vp9 -b:v 1M -deadline realtime -cpu-used 8 fixtures/cam.webm
python3 - <<'PY'
import json, math
ev=[]
def add(t,x,y,kind="move",cur="arrow"):
    ev.append({"t":t,"kind":kind,"tab":[x,y],"win":[x,y],"mon":[x,y],"cursor":cur})
t=200
# wander, click on box A (~0.17,0.3) at 2.0s and 2.8s, drift, click on blue button (~0.8,0.8) at 6.5s, text at 9.5s
path=[(0.5,0.5,200),(0.17,0.3,1900),(0.2,0.33,2700),(0.6,0.55,5000),(0.8,0.8,6400),(0.82,0.8,7000),(0.4,0.15,9400),(0.5,0.4,11800)]
for (x0,y0,t0),(x1,y1,t1) in zip(path,path[1:]):
    for k in range(int((t1-t0)/16)):
        u=k*16/(t1-t0); s=u*u*(3-2*u)
        add(t0+k*16, x0+(x1-x0)*s+0.004*math.sin(k/3), y0+(y1-y0)*s)
for tc,x,y,cur in [(2000,0.17,0.3,"pointer"),(2800,0.2,0.33,"pointer"),(6500,0.8,0.8,"pointer"),(9500,0.4,0.15,"text")]:
    add(tc,x,y,"down",cur); add(tc+90,x,y,"up",cur)
ev.sort(key=lambda e:e["t"])
json.dump({"meta":{"surface":"browser","width":1280,"height":720,"hasCamera":True,"hasMic":True},"events":ev},open("fixtures/events.json","w"))
print(len(ev),"events")
PY
