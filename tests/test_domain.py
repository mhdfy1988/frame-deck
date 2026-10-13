from fractions import Fraction as F
import pytest
from app.domain import DomainError, ExtractionRequest, SourceFrame, adapt_v1, choose_samples, manifest, targets


def source(times):
    return [SourceFrame(i, i, F(time), F(1, 24)) for i, time in enumerate(times)]


def test_half_open_and_fractional_tail():
    start, end, grid = targets("0.25", "1.251", 12, F(2), 320, 180)
    assert len(grid) == 13 and grid[-1] == F(5, 4)
    samples = choose_samples(grid, end, source([F(i, 24) for i in range(48)]))
    assert sum(item.duration for item in samples) == end - start
    assert samples[-1].duration == F(1, 1000)


def test_nearest_tie_earlier_range_restricted():
    samples = choose_samples([F(1, 8), F(3, 8)], F(1, 2), source([0, F(1, 4), F(1, 2)]))
    assert [sample.source.index for sample in samples] == [1, 1]
    tied = choose_samples([F(0), F(1, 8)], F(1, 2), source([0, F(1, 4)]))
    assert tied[-1].source.index == 0


def test_empty_interval_rejected_not_filled():
    with pytest.raises(DomainError, match="没有源画面"):
        choose_samples([F(1, 100)], F(2, 100), source([0, F(1, 24)]))


@pytest.mark.parametrize("start,end,fps", [(-1,1,12),(0,3,12),(1,1,12),(0,1,0),(0,1,61),(0,1,12.1),(0,1,True),("nan",1,12)])
def test_invalid_parameters(start,end,fps):
    with pytest.raises(DomainError): targets(start,end,fps,F(2),320,180)


def test_pixel_budget_and_count():
    with pytest.raises(DomainError, match="像素总量"): targets(0,20,30,F(60),3840,2160)
    with pytest.raises(DomainError, match="最多"): targets(0,60,30,F(60),320,180)


def test_schema_runtime_rejects_unknown_and_bad_id():
    with pytest.raises(ValueError): ExtractionRequest(videoId="../",start=0,end=1,fps=12)
    with pytest.raises(ValueError): ExtractionRequest(videoId="a"*32,start=0,end=1,fps=12,extra="x")


def test_manifest_exact_time_and_explicit_v1():
    _,end,grid=targets(0,1,30,F(1),320,180)
    data=manifest("id","测试",{"kind":"video"},320,180,F(0),end,30,choose_samples(grid,end,source([F(i,30) for i in range(30)])))
    assert data["formatVersion"]==2
    assert sum(F(frame["durationSeconds"]) for frame in data["frames"])==1
    v1=adapt_v1(data)
    assert v1["formatVersion"]==1 and sum(frame["durationMs"] for frame in v1["frames"])==1000
    assert len(set(frame["id"] for frame in data["frames"]))==30
