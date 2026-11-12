// Official public sources checked 2026-11-12. Facts do not establish surveyed geometry.
export const PUBLIC_FACTORY_REFERENCES = Object.freeze([
  {id:'hyunjin',name:'현진정공 · 칠곡',focus:'CNC 가공 → 세척 → 측정 → 검사 → 출하',
   facts:'공식 생산시스템 페이지에 CNC 자동선반 62대와 주요 계측장비, 공정 순서가 공개되어 있습니다.',
   usable:'현재 가공·이송 셀 시연과 공정 구성이 가장 가깝습니다.',
   missing:'건물 평면도, 설비별 실제 좌표·사이클타임은 확인되지 않았습니다. 기존 42×20m·24대 장면은 대표 구역을 가정한 재구성입니다.',
   url:'https://hyunjin-cnc.com/ko/system.html',source:'현진정공 생산시스템',date:'2026-11-12 확인'},
  {id:'bmw-debrecen',name:'BMW · 데브레첸',focus:'프레스 · 차체 · 조립 · 물류',
   facts:'BMW는 공장을 가상 환경에서 먼저 계획했으며, NVIDIA는 OpenUSD·Omniverse 기반 FactoryExplorer를 소개합니다.',
   usable:'산업용 로봇·공장 계획 시연을 설명하는 대표 참고 사례입니다.',
   missing:'공개 소개 자료는 실제 공장 CAD·설비 좌표·검증 로그를 제공하지 않습니다. 브랜드 공장 전체를 복제했다고 표시하지 않습니다.',
   url:'https://www.bmwgroup.com/en/news/general/2025/series-production-of-the-BMW-iX3.html',source:'BMW Group 공식 생산 소개',date:'2025-09-30'},
  {id:'hyundai-hmgics',name:'현대자동차그룹 · HMGICS',focus:'셀 생산 · 작업자 · 로봇 물류',
   facts:'현대자동차그룹은 셀 생산, 작업자와 로봇을 포함하는 디지털 공장과 원격 모니터링·시뮬레이션 활용을 설명합니다.',
   usable:'사람의 동선과 로봇 물류를 함께 보여주는 참고 사례입니다.',
   missing:'공개 설명만으로 각 셀 치수, 로봇 정지거리와 안전 설계를 확정할 수 없습니다.',
   url:'https://www.hyundaimotorgroup.com/en/story/CONT0000000000126053',source:'현대자동차그룹 디지털 트윈 소개',date:'2023-12-11'},
  {id:'siemens-amberg',name:'Siemens · 암베르크',focus:'전자부품 생산 · 공정 검증',
   facts:'Siemens는 디지털 트윈으로 생산 모듈과 사이클타임을 검토한 사례를 공개합니다.',
   usable:'입력 조건 → 시뮬레이션 → 개선안 비교의 근거 중심 설명에 적합합니다.',
   missing:'기업이 발표한 품질률이나 생산성 수치를 RoboCell 측정 결과로 사용하지 않습니다.',
   url:'https://www.siemens.com/en-gb/company/insights/electronics-digital-enterprise-future-technologies/',source:'Siemens Electronics Works Amberg',date:'2026-11-12 확인'},
]);

export const SAFETY_REFERENCES = Object.freeze([
 {label:'ISO 10218-2:2025 · 산업용 로봇 응용 및 셀',url:'https://www.iso.org/standard/73934.html'},
 {label:'ISO 13855:2024 · 사람의 접근에 따른 방호장치 배치',url:'https://www.iso.org/standard/80590.html'},
]);
