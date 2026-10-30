"""Run steps 1-5 for one reporting run. Each step runs only when its inputs exist."""
from .iprs import IPRSFormatError, parse_iprs
from .mapping import fill_gaps, map_to_master
from .master import MasterFormatError, parse_master
from .prs import SocietyFormatError, parse_prs
from .tunecodes import search_tunecodes


def _no_iprs(client):
    """Stand-in when a society is checked before the IPRS report is in: the catalogue is the master alone."""
    return {"client": client or {"name": "", "ipi_name_no": ""}, "works": [], "issues": [], "cleanup": [], "checks": [],
            "stats": {"works": 0, "contributor_rows": 0, "footer_count": None, "rows_per_work": {}, "languages": {},
                      "categories": {}, "client_roles": {}}}


def run_pipeline(iprs_path=None, master_path=None, prs_path=None, decisions=None, societies=("IPRS", "PRS"), client=None,
                 master=None):
    """master: the master already parsed (parse_master of master_path), so it is not read twice."""
    out = {"iprs": None, "master": master, "prs": None, "mapping": None, "final": None, "tunecodes": None, "errors": {}}
    if iprs_path:
        try:
            out["iprs"] = parse_iprs(iprs_path)
        except IPRSFormatError as e:
            out["errors"]["iprs"] = {"message": str(e), "checks": e.checks}
    if master_path and master is None:
        try:
            out["master"] = parse_master(master_path)
        except MasterFormatError as e:
            out["errors"]["master"] = {"message": str(e)}
    if prs_path:
        try:
            out["prs"] = parse_prs(prs_path)
        except SocietyFormatError as e:
            out["errors"]["prs"] = {"message": str(e)}
    iprs = out["iprs"]
    if iprs is None and out["master"] and out["prs"] and "PRS" in societies:
        iprs = _no_iprs(client)
    if iprs and out["master"]:
        out["mapping"] = map_to_master(iprs, out["master"], decisions or {})
        out["final"] = fill_gaps(iprs, out["master"], out["mapping"])
        out["tunecodes"] = search_tunecodes(iprs, out["master"], out["mapping"], out["final"], out["prs"], societies)
    return out
