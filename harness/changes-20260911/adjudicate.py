#!/usr/bin/env python3
"""Post-hoc adjudicator for manic_miner runs.

The campaign oracle (run_game.js) pumps 30 frames with started:false, so it
never reaches the physics path at frame 181. A run can therefore delete-and-
not-restore a function that only the physics path calls and still score ok:true.
This checks the three functions the injected fault removes are actually bound.
Does NOT touch run_game.js -- that is the campaign constant.
"""
import re,sys,os,glob,json,subprocess

REQUIRED=("initClouds","collide","setupLevel")

def script_of(path):
    h=open(path,encoding="utf-8",errors="replace").read()
    return "\n".join(re.findall(r'<script[^>]*>(.*?)</script>', h, re.S))

def bound(src,name):
    return bool(re.search(r'(function\s+%s\b|(?:const|let|var)\s+%s\s*=)'%(name,name), src))

def parses(src):
    p=subprocess.run(["node","-e",
        "const s=require('fs').readFileSync(process.argv[1],'utf8');try{new Function(s);console.log('OK')}catch(e){console.log('FAIL: '+e.message)}",
        "/dev/stdin"],input=src,capture_output=True,text=True)
    return p.stdout.strip()

for d in sorted(sys.argv[1:]):
    after=os.path.join(d,"manic_miner.after.html")
    if not os.path.exists(after):
        print(f"{os.path.basename(d)}  (no after file)"); continue
    src=script_of(after)
    missing=[f for f in REQUIRED if not bound(src,f) and re.search(r'\b%s\('%f,src)]
    ex=os.path.join(d,"exit.txt")
    verdict=open(ex).read().split()[0].split("=")[1] if os.path.exists(ex) else "?"
    ok = parses(src)=="OK" and not missing
    print(f"{os.path.basename(d)}  oracle={verdict:<7} parse={parses(src):<12} "
          f"adjudicated={'PASS' if ok else 'FAIL'}"
          + (f"  called-but-undefined: {', '.join(missing)}" if missing else ""))
