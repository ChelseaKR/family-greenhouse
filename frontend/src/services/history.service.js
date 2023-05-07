import http from "../http-common";

class HistoryDataService {
    get(id) {
        return http.get(`/history/${id}`);
    }

    update(id, data) {
        return http.put(`/history/${id}`, data);
    }

    delete(id) {
        return http.delete(`/history/${id}`);
    }

    deleteAll() {
        return http.delete(`/history`);
    }

    findByGreenhouse(greenhouse) {
        return http.get(`/history?greenhouse=${greenhouse}`);
    }
}

export default new HistoryDataService();