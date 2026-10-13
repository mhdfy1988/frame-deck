import subprocess
from threading import Event
import pytest
from PIL import Image
from app.domain import choose_samples, targets
from app.media import Cancelled, decode_selected, probe, remove_owned, run_process


@pytest.mark.parametrize("name", ["cfr","offset","rotated","sar","ntsc","vfr"])
def test_real_source_mapping_dimensions_and_pixels(fixtures,tmp_path,name):
    path=fixtures[name]
    video=probe(path)
    start,end,grid=targets(.25,1.25,12,video.duration,video.width,video.height)
    samples=choose_samples(grid,end,list(video.frames))
    indices=sorted({sample.source.index for sample in samples})
    selected_dir=tmp_path/"selected";selected_dir.mkdir()
    selected=decode_selected(path,video,indices,selected_dir,Event(),30,lambda:None)
    reference_dir=tmp_path/"reference";reference_dir.mkdir()
    # 独立全帧解码，不用候选的select逻辑当正确性真值。
    result=subprocess.run(["ffmpeg","-v","error","-y","-threads","2","-i",str(path),"-map",f"0:{video.stream_index}","-vf",f"scale={video.width}:{video.height},setsar=1","-fps_mode","passthrough","-pix_fmt","rgb24",str(reference_dir/"%06d.png")],capture_output=True,timeout=30)
    assert result.returncode==0,result.stderr
    for index,image_path in selected.items():
        with Image.open(image_path) as actual,Image.open(reference_dir/f"{index+1:06d}.png") as expected:
            assert actual.size==(video.width,video.height)
            assert actual.tobytes()==expected.tobytes()
    if name=="offset":assert video.origin_pts>0
    if name=="rotated":assert (video.width,video.height)==(180,320)
    if name=="sar":assert (video.width,video.height)==(341,180)
    if name=="vfr":assert video.variable


def test_cancel_confirms_process_exit():
    import sys,time
    event=Event();event.set();before=time.monotonic()
    with pytest.raises(Cancelled):run_process([sys.executable,"-c","import time;time.sleep(30)"],5,event)
    assert time.monotonic()-before<4


def test_maximum_600_irregular_selections_parse_and_map(tmp_path):
    path=tmp_path/'many.mp4'
    result=subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=64x32:rate=30:duration=40','-c:v','libx264','-threads','2',str(path)],capture_output=True,timeout=30)
    assert result.returncode==0,result.stderr
    video=probe(path)
    destination=tmp_path/'selected';destination.mkdir()
    indices=list(range(0,1200,2))
    selected=decode_selected(path,video,indices,destination,Event(),30,lambda:None)
    assert len(selected)==600 and list(selected)==indices
    reference=tmp_path/'reference';reference.mkdir()
    result=subprocess.run(['ffmpeg','-v','error','-y','-threads','2','-filter_threads','2','-i',str(path),'-fps_mode','passthrough','-c:v','png','-threads','2','-pix_fmt','rgb24',str(reference/'%06d.png')],capture_output=True,timeout=30)
    assert result.returncode==0,result.stderr
    for index,image_path in selected.items():
        with Image.open(image_path) as actual,Image.open(reference/f'{index+1:06d}.png') as expected:
            assert actual.tobytes()==expected.tobytes()


def test_timeout_confirms_exit():
    import sys
    from app.domain import DomainError
    with pytest.raises(DomainError,match="超时"):run_process([sys.executable,"-c","import time;time.sleep(30)"],.1)


def test_remove_owned_rejects_root_and_escape(tmp_path):
    from app.domain import DomainError
    with pytest.raises(DomainError):remove_owned(tmp_path,tmp_path)
    with pytest.raises(DomainError):remove_owned(tmp_path.parent,tmp_path)


def test_webm_actual_decode(fixtures,tmp_path):
    from conftest import command
    path=tmp_path/'video.webm'
    command(['ffmpeg','-v','error','-y','-i',str(fixtures['cfr']),'-c:v','libvpx-vp9','-threads','2',str(path)])
    video=probe(path)
    dest=tmp_path/'frames';dest.mkdir()
    selected=decode_selected(path,video,[0,6,12],dest,Event(),30,lambda:None)
    assert len(selected)==3 and video.codec=='vp9'


def test_audio_only_and_hdr_rejected(fixtures,tmp_path):
    from conftest import command
    from app.domain import DomainError
    audio=tmp_path/'audio.mp4'
    command(['ffmpeg','-v','error','-y','-f','lavfi','-i','anullsrc','-t','0.2','-c:a','aac',str(audio)])
    with pytest.raises(DomainError,match='没有'):probe(audio)
    hdr=tmp_path/'hdr.mp4'
    command(['ffmpeg','-v','error','-y','-i',str(fixtures['cfr']),'-vf','setparams=color_trc=smpte2084:color_primaries=bt2020','-c:v','libx264','-threads','2',str(hdr)])
    with pytest.raises(DomainError,match='HDR'):probe(hdr)


def test_directory_size_updates_without_stale_cache(tmp_path):
    from app.media import directory_bytes
    folder=tmp_path/'data';folder.mkdir();file=folder/'part';file.write_bytes(b'a'*100)
    assert directory_bytes(folder)==100
    file.write_bytes(b'a'*200)
    assert directory_bytes(folder)==200
