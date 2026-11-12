# RoboCell Studio

제조설비 상태 분석 및 이상징후 탐지 서비스 · 2026 동북권 오픈소스 경진대회 5팀

- [공개 데모](http://13.207.111.2/studio.html)
- 3D 공장 배치 → 설비 상태/CSV 분석 → 근거를 인용하는 AI 검토 → 보고서
- 원본 CSV 분석은 브라우저에서 수행하고 제한된 요약만 AWS Bedrock에 전송합니다.

## 빠른 실행

Node.js 22 이상에서 별도 npm 패키지 설치 없이 실행합니다.

```sh
npm run dev
```

http://127.0.0.1:4178/studio.html 에서 편집기를 엽니다. AI 및 GPU 연결이 없으면 해당 기능은 미연결로 표시됩니다. 예시 배치와 센서 데이터는 합성 예시이며 실제 현장 실측 데이터가 아닙니다.

```sh
npm test
npm run check
python -m unittest discover -s server -p 'test_*.py' -v
```

AI 서버 실행과 Nginx 배포는 [server/README.md](server/README.md)를 참고하세요. EC2 인스턴스 IAM 역할을 사용합니다. 저장소에는 AWS 키나 SSH 개인키가 없습니다. 로컬 AI 게이트웨이는 `AI_BASE_URL` 환경변수로 운영자가 고정 주소를 설정합니다. 로컬 Isaac 게이트웨이는 `ISAAC_BASE_URL`로 설정하며 공개 서버는 GPU 제어를 제공하지 않습니다.

## 구현 범위

- Three.js 3D 배치, 정밀 위치/회전, 네 가지 공장 예시, 배치 저장/비교, 입력 근거 관리
- 온도·진동·전류·사이클 CSV의 임계값 및 초기 중앙값 대비 변화 분석
- 실제 Isaac 실행 상태/기록과 센서 CSV의 출처 분리
- Amazon Bedrock Claude Haiku 4.5의 실제 질의·보고서 의견, 제한된 근거 인용
- 배치도·입력 근거·실행 근거·진단 요약·AI 의견이 포함된 HTML/텍스트 보고서
- 로컬 운영 환경에서 실제 RTX 5090 Isaac 실행/영상/일시정지/종료 검증

현재 Isaac 어댑터는 고정 로봇 셀과 지원된 공장/구역 필드만 반영합니다. 일반 자유 설비 배치 전체의 동작 시뮬레이션, 현장 고장 라벨에 대한 탐지 정확도 검증, 안전 인증은 완료된 기능으로 주장하지 않습니다. 보관 영상은 2026.11.02 사전 실행 자료이며 현재 배치의 실시간 결과와 별개입니다. 공개 서비스는 대회 제공 EC2의 운영 기간에 한정될 수 있습니다.

## 팀

| 팀원 | 담당 |
|---|---|
| 전성빈 | PM·기획 |
| 박종진 | AI 모델 구현·연동 |
| 나유빈 | 프론트엔드·백엔드 |
| 허성찬 | UI/UX |
| 권보경 | 자료조사·디자인·발표자료 제작 |

## 오픈소스 및 AI 활용

Three.js/OrbitControls(MIT), IBM Plex Sans KR 및 비교용 글꼴(OFL)의 고지는 `web/vendor/three/LICENSE`와 `web/assets/fonts/`에 보존했습니다. AI 개발 보조는 OpenAI Codex, 제품의 생성형 AI는 Amazon Bedrock의 Claude Haiku 4.5입니다. 자체 학습 고장 예측 모델 또는 자체 물리 엔진으로 표시하지 않습니다. NVIDIA Isaac Sim과 제공 로봇 자산은 NVIDIA 및 해당 자산의 라이선스를 따릅니다. 상세 내역은 `SOURCES_OSS_AI.txt`를 참고하세요.
